import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CAPABILITY_TABLE,
  type FixtureOperation,
  type FixtureSetup,
} from '../generated/contract.generated.js';
import { INVALID_PARAMS_CODE } from '../wire/errors.js';
import { WIRE_METHOD_REGISTRY } from '../wire/registry.js';
import {
  type MessagingRowMethod,
  validateMessagingRowInput,
} from '../validation/messaging-wire.js';
import type {
  BehaviorAdapter,
  BehaviorTarget,
  BehaviorVerdict,
} from './behavior-executor.js';
import { M0C_BEHAVIOR_CASE_IDS } from './messaging-behavior-fixture.js';
import { MessagingLoopbackAdapter } from './messaging-loopback-adapter.js';
import { runConformance } from './runner.js';

const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020') as new (options: {
  allErrors: boolean;
  strict: boolean;
}) => {
  addSchema(schema: object, id: string): void;
  compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown[] | null };
};
const addFormats = require('ajv-formats') as (ajv: object) => void;

const manifestSchema = JSON.parse(
  readFileSync(new URL('../schemas/manifest.schema.json', import.meta.url), 'utf8'),
) as object & { $id: string };
const signalSchema = JSON.parse(
  readFileSync(new URL('../schemas/signal.schema.json', import.meta.url), 'utf8'),
) as object & { $id: string };
const behaviorSchema = JSON.parse(
  readFileSync(new URL('../schemas/behavior-fixture.schema.json', import.meta.url), 'utf8'),
) as {
  $defs: { CapabilityName: unknown };
};
const behaviorFixture = JSON.parse(
  readFileSync(
    new URL('../../fixtures/behavior/messaging/adversarial-invariants.json', import.meta.url),
    'utf8',
  ),
) as { cases: Array<Record<string, unknown>> };

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(signalSchema, signalSchema.$id);
ajv.addSchema(manifestSchema, manifestSchema.$id);
const validate = ajv.compile(behaviorSchema);

function caseById(id: string): Record<string, unknown> {
  const behaviorCase = behaviorFixture.cases.find((candidate) => candidate['id'] === id);
  assert.ok(behaviorCase, `missing signed behavior case: ${id}`);
  return behaviorCase;
}

interface MutableExecution {
  plane: string;
  method?: string;
  verdictOracle: { kind: string; code?: number; sideEffects?: string };
}

function executionOf(behaviorCase: Record<string, unknown>): MutableExecution {
  const execution = behaviorCase['execution'] as MutableExecution | undefined;
  assert.ok(execution, `${String(behaviorCase['id'])}: missing execution contract`);
  return execution;
}

test('committed behavior fixture is structurally executable', () => {
  assert.equal(validate(behaviorFixture), true, JSON.stringify(validate.errors));
});

test('M0-C exports the canonical 18 behavior-case identities in fixture order', () => {
  assert.equal(M0C_BEHAVIOR_CASE_IDS.length, 18);
  assert.deepEqual(
    M0C_BEHAVIOR_CASE_IDS,
    behaviorFixture.cases.map(behaviorCase => behaviorCase['id']),
  );
});

test('M0-D fixture signs one machine-readable execution plane and verdict oracle per case', () => {
  const executions = behaviorFixture.cases.map(behaviorCase => {
    const execution = executionOf(behaviorCase) as MutableExecution & {
      method?: MessagingRowMethod;
    };
    return { behaviorCase, execution };
  });

  assert.deepEqual(
    Object.fromEntries(
      [...new Set(executions.map(({ execution }) => execution.plane))]
        .sort()
        .map(plane => [
          plane,
          executions.filter(({ execution }) => execution.plane === plane).length,
        ]),
    ),
    {
      'host-control': 5,
      'host-to-plugin-delivery': 1,
      'plugin-to-host-wire': 9,
      'wire-admission': 3,
    },
  );

  for (const { behaviorCase, execution } of executions) {
    const id = String(behaviorCase['id']);
    const operation = (behaviorCase['when'] as FixtureOperation).operation;

    if (execution.plane === 'host-control') {
      assert.equal(execution.method, undefined, `${id}: Host control must not invent a wire method`);
      assert.deepEqual(execution.verdictOracle, { kind: 'behavior-expectation' });
      continue;
    }

    assert.ok(execution.method, `${id}: wire execution must name its exact method`);
    const registryRow = WIRE_METHOD_REGISTRY[execution.method];
    assert.ok(registryRow, `${id}: method must exist in the public registry`);

    if (execution.plane === 'host-to-plugin-delivery') {
      assert.equal(operation, 'deliverOnMessage');
      assert.equal(registryRow.direction, 'host-to-plugin');
      assert.deepEqual(execution.verdictOracle, { kind: 'behavior-expectation' });
      continue;
    }

    assert.equal(registryRow.direction, 'plugin-to-host');
    const validation = validateMessagingRowInput(
      execution.method,
      (behaviorCase['when'] as { input: unknown }).input,
    );
    if (execution.plane === 'wire-admission') {
      assert.equal(validation.valid, false, `${id}: admission case must be wire-invalid`);
      assert.deepEqual(execution.verdictOracle, {
        kind: 'json-rpc-error',
        code: INVALID_PARAMS_CODE,
        sideEffects: 'behavior-expectation',
      });
      continue;
    }

    assert.equal(execution.plane, 'plugin-to-host-wire');
    assert.equal(validation.valid, true, `${id}: domain case must pass wire admission`);
    assert.deepEqual(execution.verdictOracle, { kind: 'behavior-expectation' });
  }
});

test('behavior fixture schema requires the execution contract', () => {
  const malformed = structuredClone(behaviorFixture);
  delete malformed.cases[0]!['execution'];

  assert.equal(validate(malformed), false);
});

test('behavior fixture schema rejects cross-plane methods and admission oracles', () => {
  const wrongControlMethod = structuredClone(behaviorFixture);
  const controlCase = wrongControlMethod.cases.find(
    behaviorCase => executionOf(behaviorCase).plane === 'host-control',
  );
  assert.ok(controlCase);
  executionOf(controlCase).method = 'messaging.send';
  assert.equal(validate(wrongControlMethod), false);

  const wrongAdmissionCode = structuredClone(behaviorFixture);
  const admissionCase = wrongAdmissionCode.cases.find(
    behaviorCase => executionOf(behaviorCase).plane === 'wire-admission',
  );
  assert.ok(admissionCase);
  executionOf(admissionCase).verdictOracle.code = -32603;
  assert.equal(validate(wrongAdmissionCode), false);

  const wrongDeliveryMethod = structuredClone(behaviorFixture);
  const deliveryCase = wrongDeliveryMethod.cases.find(
    behaviorCase => executionOf(behaviorCase).plane === 'host-to-plugin-delivery',
  );
  assert.ok(deliveryCase);
  executionOf(deliveryCase).method = 'messaging.send';
  assert.equal(validate(wrongDeliveryMethod), false);

  const wrongOperationMethod = structuredClone(behaviorFixture);
  const sendCase = wrongOperationMethod.cases.find(
    behaviorCase => behaviorCase['when'] !== undefined
      && (behaviorCase['when'] as { operation?: string }).operation === 'send'
      && executionOf(behaviorCase).plane === 'plugin-to-host-wire',
  );
  assert.ok(sendCase);
  executionOf(sendCase).method = 'messaging.read';
  assert.equal(validate(wrongOperationMethod), false);

  const wrongHostControlPlane = structuredClone(behaviorFixture);
  const presetCase = wrongHostControlPlane.cases.find(
    behaviorCase => (behaviorCase['when'] as { operation?: string }).operation === 'applyGrantPreset',
  );
  assert.ok(presetCase);
  presetCase['execution'] = {
    plane: 'plugin-to-host-wire',
    method: 'messaging.send',
    verdictOracle: { kind: 'behavior-expectation' },
  };
  assert.equal(validate(wrongHostControlPlane), false);
});

test('behavior fixture rejects a case without an operation input', () => {
  const malformed = structuredClone(behaviorFixture);
  delete malformed.cases[0]!.when;

  assert.equal(validate(malformed), false);
});

test('behavior fixture rejects a case without side-effect assertions', () => {
  const malformed = structuredClone(behaviorFixture);
  malformed.cases[0]!.expect = {
    status: 'error',
    errorCode: 'PERMISSION',
  };

  assert.equal(validate(malformed), false);
});

test('behavior fixture rejects an operation with an empty input shell', () => {
  const malformed = structuredClone(behaviorFixture);
  malformed.cases[0]!.when = { operation: 'send', input: {} };

  assert.equal(validate(malformed), false);
});

test('behavior fixture requires an oracle value for value-bearing assertions', () => {
  const malformed = structuredClone(behaviorFixture);
  const expectation = malformed.cases[0]!.expect as {
    sideEffects: Array<Record<string, unknown>>;
  };
  expectation.sideEffects[0] = {
    target: 'subscription',
    assertion: 'state_equals',
  };

  assert.equal(validate(malformed), false);
});

test('behavior fixture rejects an errorCode on a success verdict', () => {
  const malformed = structuredClone(behaviorFixture);
  malformed.cases[0]!.expect = {
    status: 'success',
    errorCode: 'VALIDATION',
    sideEffects: [{ target: 'messages', assertion: 'unchanged' }],
  };

  assert.equal(validate(malformed), false);
});

test('behavior capability names use the Manifest capability truth source', () => {
  assert.deepEqual(behaviorSchema.$defs.CapabilityName, {
    $ref: 'https://clowder-ai.dev/schemas/manifest/v0.1#/$defs/Capability',
  });
});

test('behavior fixture rejects a capability absent from the Manifest schema', () => {
  const malformed = structuredClone(behaviorFixture);
  const preset = malformed.cases.find((candidate) => candidate['id'] === 'preset-l2-rejected');
  assert.ok(preset);
  (preset['when'] as { input: { capabilities: string[] } }).input.capabilities = [
    'not.in.manifest',
  ];

  assert.equal(validate(malformed), false);
});

test('behavior fixture rejects a setup grant absent from the Manifest schema', () => {
  const malformed = structuredClone(behaviorFixture);
  (malformed.cases[0]!['given'] as { grants: string[] }).grants = ['not.in.manifest'];

  assert.equal(validate(malformed), false);
});

test('behavior fixture covers signed first-party preset and empty whisper defaults', () => {
  const rejectedPreset = caseById('preset-l2-rejected');
  assert.deepEqual(
    (rejectedPreset['when'] as { input: { capabilities: string[] } }).input.capabilities,
    ['onMessage'],
  );
  assert.equal(
    (rejectedPreset['expect'] as { errorCode?: string }).errorCode,
    'PERMISSION',
  );

  const revocablePreset = caseById('preset-visible-revocable');
  assert.deepEqual(
    (revocablePreset['expect'] as { sideEffects: unknown[] }).sideEffects,
    [
      {
        target: 'grant_state',
        assertion: 'state_equals',
        value: { capability: 'messaging.send', visible: true, granted: false },
      },
    ],
  );

  const whisper = caseById('whisper-target-beyond-default-empty-grant-rejected');
  assert.deepEqual(
    (whisper['given'] as { grants: string[] }).grants,
    ['messaging.send'],
  );
  assert.deepEqual(
    (whisper['given'] as { state: { whisperGrantTargets: string[] } }).state
      .whisperGrantTargets,
    [],
  );
  assert.equal((whisper['expect'] as { errorCode?: string }).errorCode, 'PERMISSION');
});

test('behavior fixture covers missing grants and the complete permission matrix', () => {
  for (const id of ['append-without-grant-rejected', 'denied-on-message-rejected']) {
    const denied = caseById(id);
    assert.deepEqual((denied['given'] as { grants: string[] }).grants, []);
    assert.equal((denied['expect'] as { errorCode?: string }).errorCode, 'PERMISSION');
  }

  const matrix = caseById('permission-matrix-complete');
  const entries = (matrix['when'] as {
    input: {
      entries: Array<{
        capability: string;
        layer: keyof typeof CAPABILITY_TABLE;
        firstPartyPreset: boolean;
      }>;
    };
  }).input.entries;
  const expectedEntries = Object.entries(CAPABILITY_TABLE).flatMap(
    ([layer, capabilities]) =>
      capabilities.map((capability) => ({
        capability,
        layer,
        firstPartyPreset: layer === 'L1',
      })),
  );
  assert.deepEqual(entries, expectedEntries);

  const matrixOracle = (
    matrix['expect'] as {
      sideEffects: Array<{ target: string; assertion: string; value?: unknown }>;
    }
  ).sideEffects.find((sideEffect) => sideEffect.target === 'permission_matrix');
  assert.deepEqual(matrixOracle, {
    target: 'permission_matrix',
    assertion: 'matches',
    value: {
      complete: true,
      firstPartyPresetLayers: ['L1'],
      defaultWhisperTargets: [],
    },
  });
});

test('deleting replay events cannot delete canonical messages', () => {
  const behaviorCase = caseById('delete-replay-events-preserves-canonical-messages');
  assert.deepEqual(
    (behaviorCase['expect'] as { sideEffects: unknown[] }).sideEffects,
    [
      { target: 'replay_events', assertion: 'none' },
      { target: 'messages', assertion: 'unchanged' },
    ],
  );
});

test('behavior fixture ships subscription authorization oracles', () => {
  const missingGrant = caseById('snapshot-without-grant-rejected');
  assert.deepEqual(missingGrant['when'], {
    operation: 'snapshot',
    input: { subscriptionId: 'subscription-a' },
  });
  assert.equal(
    (missingGrant['expect'] as { errorCode?: string }).errorCode,
    'PERMISSION',
  );

  const foreignDelete = caseById('foreign-replay-delete-rejected');
  assert.deepEqual(
    (foreignDelete['given'] as { caller: { pluginInstanceId: string } }).caller,
    { pluginInstanceId: 'plugin-b' },
  );
  assert.equal(
    (foreignDelete['expect'] as { errorCode?: string }).errorCode,
    'PERMISSION',
  );
});

test('conformance executes every loopback behavior case', async () => {
  const report = await runConformance({ write: () => undefined });

  assert.equal(report.contractFixtures.passed, 32);
  assert.equal(report.contractFixtures.total, 32);
  assert.equal(report.behaviorCases.passed, 18);
  assert.equal(report.behaviorCases.total, 18);
  assert.deepEqual(report.failures, []);
});

class MutatedObservationAdapter implements BehaviorAdapter {
  private readonly inner = new MessagingLoopbackAdapter();
  private executed = false;

  async setup(given: FixtureSetup): Promise<void> {
    this.executed = false;
    await this.inner.setup(given);
  }

  async observe(target: BehaviorTarget): Promise<unknown> {
    const observation = await this.inner.observe(target);
    if (this.executed && target === 'permission_matrix' && observation !== undefined) {
      return { complete: false };
    }
    return observation;
  }

  async execute(operation: FixtureOperation): Promise<BehaviorVerdict> {
    const verdict = await this.inner.execute(operation);
    this.executed = true;
    return verdict;
  }
}

test('conformance fails when an adapter observation violates the oracle', async () => {
  const report = await runConformance({
    write: () => undefined,
    behaviorAdapters: {
      loopback: () => new MutatedObservationAdapter(),
    },
  });

  assert.equal(report.behaviorCases.passed, 17);
  assert.equal(report.behaviorCases.total, 18);
  assert.match(report.failures.join('\n'), /permission-matrix-complete.*permission_matrix/);
});

test('conformance rejects an empty fixture tree', async (context) => {
  const fixturesDir = mkdtempSync(join(tmpdir(), 'clowder-empty-fixtures-'));
  context.after(() => rmSync(fixturesDir, { recursive: true, force: true }));

  const report = await runConformance({
    fixturesDir,
    write: () => undefined,
  });

  assert.deepEqual(report.contractFixtures, { passed: 0, total: 0 });
  assert.deepEqual(report.behaviorCases, { passed: 0, total: 0 });
  assert.deepEqual(report.failures, [
    'no contract fixtures discovered',
    'no behavior cases discovered',
  ]);
});

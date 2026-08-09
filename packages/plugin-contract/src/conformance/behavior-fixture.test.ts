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
import type {
  BehaviorAdapter,
  BehaviorTarget,
  BehaviorVerdict,
} from './behavior-executor.js';
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

test('committed behavior fixture is structurally executable', () => {
  assert.equal(validate(behaviorFixture), true, JSON.stringify(validate.errors));
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

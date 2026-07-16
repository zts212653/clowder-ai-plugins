import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import { CAPABILITY_TABLE } from '../generated/contract.generated.js';

const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020') as new (options: {
  allErrors: boolean;
  strict: boolean;
}) => {
  compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown[] | null };
};

const behaviorSchema = JSON.parse(
  readFileSync(new URL('../schemas/behavior-fixture.schema.json', import.meta.url), 'utf8'),
) as object;
const behaviorFixture = JSON.parse(
  readFileSync(
    new URL('../../fixtures/behavior/messaging/adversarial-invariants.json', import.meta.url),
    'utf8',
  ),
) as { cases: Array<Record<string, unknown>> };

const validate = new Ajv({ allErrors: true, strict: false }).compile(behaviorSchema);

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

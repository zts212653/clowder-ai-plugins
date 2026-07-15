import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

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

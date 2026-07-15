import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020') as new (options: {
  allErrors: boolean;
  strict: boolean;
}) => {
  addSchema(schema: object, id: string): void;
  getSchema(ref: string): ((data: unknown) => boolean) | undefined;
};
const addFormats = require('ajv-formats') as (ajv: object) => void;

const schema = JSON.parse(
  readFileSync(new URL('../schemas/messaging.schema.json', import.meta.url), 'utf8'),
) as { $id: string };
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(schema, schema.$id);

function validate(definition: string, value: unknown): boolean {
  const validator = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
  assert.ok(validator, `missing schema definition ${definition}`);
  return validator(value);
}

function makeK1Draft(): Record<string, unknown> {
  return {
    address: { kind: 'thread_handle', handle: 'host-issued-thread-handle' },
    draftAudience: { kind: 'public' },
    idempotencyKey: 'fixture-k1-draft-1',
    payload: {
      provenance: {
        origin: { kind: 'plugin', instanceId: 'plugin-instance-1' },
        epistemicStatus: 'inference',
      },
      elements: [
        {
          elementId: 'text-1',
          kind: 'text',
          payload: { text: 'hello' },
        },
      ],
    },
  };
}

test('MessageDraft accepts the current K-1 candidate shape', () => {
  assert.equal(validate('MessageDraft', makeK1Draft()), true);
});

test('text elements require payload.text to be a string', () => {
  const element = {
    elementId: 'text-1',
    kind: 'text',
    payload: { html: 'missing text' },
  };

  assert.equal(validate('MessageElement', element), false);
});

test('stale subscription reads reject events or ack tokens', () => {
  const incoherentRead = {
    events: [],
    ackToken: {
      kind: 'subscription-cursor',
      token: 'must-be-null-while-stale',
    },
    stale: true,
  };

  assert.equal(validate('SubscriptionReadResponse', incoherentRead), false);
});

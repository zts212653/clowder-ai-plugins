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

function makeTextElements(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    elementId: `text-${index + 1}`,
    kind: 'text',
    payload: { text: `message element ${index + 1}` },
  }));
}

function makeEnvelope(elementCount: number): Record<string, unknown> {
  return {
    messageId: 'message-1',
    revision: 4,
    threadId: 'thread-1',
    actor: { kind: 'plugin', id: 'plugin-1' },
    audience: { kind: 'public' },
    occurredAt: '2026-07-15T08:00:00Z',
    payload: {
      provenance: {
        origin: { kind: 'plugin', instanceId: 'plugin-instance-1' },
        epistemicStatus: 'inference',
      },
      elements: makeTextElements(elementCount),
    },
  };
}

test('MessageDraft accepts the current K-1 candidate shape', () => {
  assert.equal(validate('MessageDraft', makeK1Draft()), true);
});

test('raw-thread-id fixture isolates raw address rejection', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../fixtures/messaging/invalid/raw-thread-id.json', import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>;
  delete fixture['_meta'];

  assert.equal(validate('MessageDraft', fixture), false);

  fixture['address'] = {
    kind: 'thread_handle',
    handle: 'host-issued-thread-handle',
  };
  assert.equal(validate('MessageDraft', fixture), true);
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

test('canonical messages use the 128-element message cap in envelopes and snapshots', () => {
  const envelopeAtLimit = makeEnvelope(128);

  assert.equal(validate('MessageEnvelope', envelopeAtLimit), true);
  assert.equal(
    validate('SnapshotResponse', {
      envelopes: [envelopeAtLimit],
      resumeSequence: 42,
    }),
    true,
  );
  assert.equal(validate('MessageEnvelope', makeEnvelope(129)), false);
});

test('draft and append operations retain the 32-element operation cap', () => {
  const elements = makeTextElements(33);
  const draft = makeK1Draft();
  (draft['payload'] as Record<string, unknown>)['elements'] = elements;

  assert.equal(validate('MessageDraft', draft), false);
  assert.equal(
    validate('AppendElementsRequest', {
      handle: { kind: 'message', token: 'host-issued-message-handle' },
      operationId: 'append-1',
      elements,
    }),
    false,
  );
  assert.equal(
    validate('MessageElementsAppendEvent', {
      eventId: 'event-1',
      sequence: 3,
      type: 'message.elements.append',
      messageId: 'message-1',
      threadId: 'thread-1',
      operationId: 'append-1',
      revision: 2,
      elements,
    }),
    false,
  );
});

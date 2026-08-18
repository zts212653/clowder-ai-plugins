import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { WIRE_METHOD_REGISTRY } from '../wire/registry.js';

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
) as { $id: string; 'x-clowder-replay-window-default'?: string };
const manifestSchema = JSON.parse(
  readFileSync(new URL('../schemas/manifest.schema.json', import.meta.url), 'utf8'),
) as {
  'x-clowder-capability-layers'?: Record<string, string[]>;
  'x-clowder-data-class-strategies'?: Record<string, string[]>;
  $defs?: { Capability?: { enum?: string[] } };
  properties?: Record<string, unknown>;
};
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

test('MessageDraft accepts the K-1 shape-approved draft', () => {
  assert.equal(validate('MessageDraft', makeK1Draft()), true);
});

test('G-0 locks all 17 capability ids to their signed authorization tiers', () => {
  const expectedLayers = {
    L0: ['plugin.config.read', 'plugin.state.get', 'plugin.state.set'],
    L1: ['messaging.send', 'schedule.register', 'events.publish', 'messaging.appendElements'],
    L2: [
      'onMessage',
      'message.event.subscribe',
      'secret.read',
      'thread.listMetadata',
      'thread.readContent',
      'memory.query',
      'memory.append',
      'memory.retrieve',
      'windows.create',
      'whisper.extend',
    ],
  };
  const capabilityEnum = manifestSchema.$defs?.Capability?.enum;

  assert.deepEqual(manifestSchema['x-clowder-capability-layers'], expectedLayers);
  assert.deepEqual(capabilityEnum, Object.values(expectedLayers).flat());
  assert.equal(capabilityEnum?.length, 17);
  assert.equal(expectedLayers.L2.includes('whisper.extend'), true);
  assert.equal(capabilityEnum?.includes('lifecycle'), false);
  assert.equal('x-clowder-capability-policy' in manifestSchema, false);
  assert.equal(manifestSchema.properties?.['grantDefaults'], undefined);
  assert.equal(manifestSchema.properties?.['trustTier'], undefined);
});

test('G-0 locks the six-row dataClass by strategy matrix', () => {
  assert.deepEqual(manifestSchema['x-clowder-data-class-strategies'], {
    cache: ['lifecycle', 'retained', 'ask-on-uninstall'],
    ephemeral: ['lifecycle', 'retained', 'ask-on-uninstall'],
    'user-authored': ['retained', 'ask-on-uninstall'],
    'derived-user-visible': ['retained', 'ask-on-uninstall'],
    relationship: ['retained', 'ask-on-uninstall'],
    'interaction-history': ['retained', 'ask-on-uninstall'],
  });
});

test('G-0 locks the messaging replay transport window default to P7D', () => {
  assert.equal(schema['x-clowder-replay-window-default'], 'P7D');
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

test('occurredAt fixtures isolate timestamp validation', () => {
  for (const fixtureName of [
    'non-rfc3339-occurred-at.json',
    'non-utc-occurred-at.json',
  ]) {
    const fixture = JSON.parse(
      readFileSync(
        new URL(`../../fixtures/messaging/invalid/${fixtureName}`, import.meta.url),
        'utf8',
      ),
    ) as Record<string, unknown>;
    delete fixture['_meta'];

    assert.equal(validate('MessageEnvelope', fixture), false, fixtureName);

    fixture['occurredAt'] = '2026-07-15T08:00:00Z';
    assert.equal(validate('MessageEnvelope', fixture), true, fixtureName);
  }
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

test('message revisions are one-based across envelopes, receipts, and append guards', () => {
  const zeroRevisionEnvelope = makeEnvelope(1);
  zeroRevisionEnvelope['revision'] = 0;

  assert.equal(validate('MessageEnvelope', zeroRevisionEnvelope), false);
  assert.equal(
    validate('SendReceipt', {
      messageId: 'message-1',
      threadId: 'thread-1',
      revision: 0,
      messageHandle: { kind: 'message', token: 'host-issued-message-handle' },
    }),
    false,
  );
  assert.equal(
    validate('AppendReceipt', {
      messageId: 'message-1',
      revision: 0,
      appliedElementIds: ['text-1'],
    }),
    false,
  );
  assert.equal(
    validate('AppendElementsRequest', {
      handle: { kind: 'message', token: 'host-issued-message-handle' },
      operationId: 'append-at-zero',
      baseRevision: 0,
      elements: makeTextElements(1),
    }),
    false,
  );

  assert.equal(validate('MessageEnvelope', makeEnvelope(1)), true);
  assert.equal(
    validate('SendReceipt', {
      messageId: 'message-1',
      threadId: 'thread-1',
      revision: 1,
      messageHandle: { kind: 'message', token: 'host-issued-message-handle' },
    }),
    true,
  );
  assert.equal(
    validate('AppendReceipt', {
      messageId: 'message-1',
      revision: 1,
      appliedElementIds: ['text-1'],
    }),
    true,
  );
  assert.equal(
    validate('AppendElementsRequest', {
      handle: { kind: 'message', token: 'host-issued-message-handle' },
      operationId: 'append-at-one',
      baseRevision: 1,
      elements: makeTextElements(1),
    }),
    true,
  );
});

test('M0-C requires a closed messageHandle in every SendReceipt', () => {
  const receipt = {
    messageId: 'message-1',
    threadId: 'thread-1',
    revision: 1,
    messageHandle: { kind: 'message', token: 'host-issued-message-handle' },
  };

  assert.equal(validate('SendReceipt', receipt), true);
  assert.equal(
    validate('SendReceipt', {
      ...receipt,
      messageHandle: { kind: 'message', token: '' },
    }),
    false,
    'the receipt messageHandle keeps MessageHandle token admission',
  );
  assert.equal(
    validate('SendReceipt', {
      ...receipt,
      messageHandle: { kind: 'thread_handle', token: 'host-issued-message-handle' },
    }),
    false,
    'the receipt messageHandle keeps the MessageHandle kind discriminant',
  );
  assert.equal(
    validate('SendReceipt', {
      ...receipt,
      messageHandle: {
        kind: 'message',
        token: 'host-issued-message-handle',
        extra: true,
      },
    }),
    false,
    'the receipt messageHandle keeps the closed MessageHandle object boundary',
  );
  assert.equal(
    validate('SendReceipt', {
      messageId: 'message-1',
      threadId: 'thread-1',
      revision: 1,
    }),
    false,
    'messageHandle is required',
  );
  assert.equal(
    validate('SendReceipt', {
      messageId: 'message-1',
      threadId: 'thread-1',
      revision: 1,
      handle: { kind: 'message', token: 'legacy-handle' },
    }),
    false,
    'legacy handle is not a compatibility alias',
  );

  const sendRow = WIRE_METHOD_REGISTRY['messaging.send'];
  assert.equal(sendRow.leafClosure, 'CLOSED');
  assert.equal(sendRow.ready, true);
  assert.equal(sendRow.schemaClosurePrerequisites, undefined);
});

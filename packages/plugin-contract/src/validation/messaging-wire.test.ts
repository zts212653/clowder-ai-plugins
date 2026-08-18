import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateMessagingRowInput,
  validateMessagingRowResult,
} from './messaging-wire.js';

const draft = {
  address: { kind: 'thread_handle', handle: 'thread-handle-1' },
  idempotencyKey: 'send-1',
  payload: {
    provenance: { epistemicStatus: 'inference' },
    elements: [
      { elementId: 'element-1', kind: 'text', payload: { text: 'hello' } },
    ],
  },
} as const;

const envelope = {
  messageId: 'message-1',
  revision: 1,
  threadId: 'thread-1',
  actor: { kind: 'user', id: 'user-1' },
  audience: { kind: 'public' },
  occurredAt: '2026-08-18T03:00:00.000Z',
  payload: {
    provenance: {
      origin: { kind: 'host' },
      epistemicStatus: 'user_intent',
    },
    elements: [
      { elementId: 'element-1', kind: 'text', payload: { text: 'hello' } },
    ],
  },
} as const;

test('all seven M0-C request shapes have one executable contract validator', () => {
  for (const [method, input] of [
    ['messaging.send', draft],
    [
      'messaging.appendElements',
      {
        handle: { kind: 'message', token: 'message-handle-1' },
        operationId: 'append-1',
        baseRevision: 1,
        elements: [
          { elementId: 'element-2', kind: 'text', payload: { text: 'more' } },
        ],
      },
    ],
    ['messaging.subscribe', { handle: 'thread-handle-1' }],
    ['messaging.read', { subscriptionId: 'subscription-1', limit: 32 }],
    ['messaging.ack', { subscriptionId: 'subscription-1', ackToken: 'ack-1' }],
    ['messaging.snapshot', { subscriptionId: 'subscription-1', maxItems: 64 }],
    [
      'host.messaging.deliver',
      {
        deliveryId: 'delivery-1',
        threadHandle: { kind: 'thread_handle', handle: 'thread-handle-1' },
        envelope,
      },
    ],
  ] as const) {
    assert.equal(
      validateMessagingRowInput(method, input).valid,
      true,
      `${method} request must validate`,
    );
  }
});

test('all seven M0-C success shapes have one executable contract validator', () => {
  for (const [method, result] of [
    [
      'messaging.send',
      {
        messageId: 'message-1',
        threadId: 'thread-1',
        revision: 1,
        messageHandle: { kind: 'message', token: 'message-handle-1' },
      },
    ],
    [
      'messaging.appendElements',
      { messageId: 'message-1', revision: 2, appliedElementIds: ['element-2'] },
    ],
    ['messaging.subscribe', { subscriptionId: 'subscription-1' }],
    ['messaging.read', { events: [], ackToken: null, stale: false }],
    ['messaging.ack', null],
    [
      'messaging.snapshot',
      { items: [envelope], nextPageToken: 'page-2', snapshotAckToken: null },
    ],
    ['host.messaging.deliver', { deliveryId: 'delivery-1' }],
  ] as const) {
    assert.equal(
      validateMessagingRowResult(method, result).valid,
      true,
      `${method} result must validate`,
    );
  }
});

test('row validators reject open objects and unsafe integer leaves', () => {
  const invalidCases = [
    validateMessagingRowInput('messaging.send', { ...draft, authority: 'host' }),
    validateMessagingRowInput('messaging.read', {
      subscriptionId: 'subscription-1',
      limit: Number.MAX_SAFE_INTEGER + 1,
    }),
    validateMessagingRowInput('messaging.snapshot', {
      subscriptionId: 'subscription-1',
      maxItems: 1.5,
    }),
    validateMessagingRowResult('messaging.appendElements', {
      messageId: 'message-1',
      revision: Number.MAX_SAFE_INTEGER + 1,
      appliedElementIds: ['element-2'],
    }),
    validateMessagingRowResult('host.messaging.deliver', {
      deliveryId: 'delivery-1',
      extra: true,
    }),
  ];

  for (const result of invalidCases) assert.equal(result.valid, false);
});

test('opaque M0-C identifiers use Unicode scalar counts and reject lone surrogates', () => {
  const atLimit = '\u{1F408}'.repeat(128);
  assert.equal(
    validateMessagingRowInput('messaging.read', {
      subscriptionId: atLimit,
      limit: 1,
    }).valid,
    true,
  );

  for (const subscriptionId of [
    '\u{1F408}'.repeat(129),
    '\ud800',
  ]) {
    assert.equal(
      validateMessagingRowInput('messaging.read', { subscriptionId, limit: 1 }).valid,
      false,
    );
  }
});

test('source-owned message identifiers and handles close at 512 scalars', () => {
  const atLimit = '\u{1F408}'.repeat(512);
  assert.equal(
    validateMessagingRowResult('messaging.send', {
      messageId: atLimit,
      threadId: atLimit,
      revision: 1,
      messageHandle: { kind: 'message', token: `${atLimit}x` },
    }).valid,
    false,
    'the handle is independently bounded even when the source ids are legal',
  );
  assert.equal(
    validateMessagingRowResult('messaging.send', {
      messageId: atLimit,
      threadId: atLimit,
      revision: 1,
      messageHandle: { kind: 'message', token: `x${'\u{1F408}'.repeat(511)}` },
    }).valid,
    true,
  );
  assert.equal(
    validateMessagingRowResult('messaging.send', {
      messageId: `${atLimit}x`,
      threadId: 'thread-1',
      revision: 1,
      messageHandle: { kind: 'message', token: 'message-handle-1' },
    }).valid,
    false,
  );
});

test('envelope timestamps accept canonical Date output and reject invalid history', () => {
  for (const occurredAt of [
    '2026-08-18T03:00:00.000Z',
    '+010000-01-01T00:00:00.000Z',
  ]) {
    assert.equal(
      validateMessagingRowInput('host.messaging.deliver', {
        deliveryId: 'delivery-1',
        threadHandle: { kind: 'thread_handle', handle: 'thread-handle-1' },
        envelope: { ...envelope, occurredAt },
      }).valid,
      true,
    );
  }

  for (const occurredAt of [
    '2026-02-29T03:00:00.000Z',
    '2026-08-18T03:00:00Z',
    'not-a-date',
  ]) {
    assert.equal(
      validateMessagingRowInput('host.messaging.deliver', {
        deliveryId: 'delivery-1',
        threadHandle: { kind: 'thread_handle', handle: 'thread-handle-1' },
        envelope: { ...envelope, occurredAt },
      }).valid,
      false,
    );
  }

  const invalidEnvelope = { ...envelope, occurredAt: '2026-08-18T03:00:00Z' };
  assert.equal(
    validateMessagingRowResult('messaging.read', {
      events: [
        {
          eventId: 'event-1',
          sequence: 1,
          type: 'message.publish',
          envelope: invalidEnvelope,
        },
      ],
      ackToken: 'ack-1',
      stale: false,
    }).valid,
    false,
    'historical publish events must use canonical timestamps',
  );
  assert.equal(
    validateMessagingRowResult('messaging.snapshot', {
      items: [invalidEnvelope],
      nextPageToken: null,
      snapshotAckToken: 'snapshot-ack-1',
    }).valid,
    false,
    'historical snapshot envelopes must use canonical timestamps',
  );
});

test('read and snapshot response discriminators are closed', () => {
  const validReadResults = [
    { events: [], ackToken: null, stale: false },
    { events: [], ackToken: null, stale: true },
    {
      events: [{ eventId: 'event-1', sequence: 1, type: 'message.publish', envelope }],
      ackToken: 'ack-1',
      stale: false,
    },
  ];
  for (const result of validReadResults) {
    assert.equal(validateMessagingRowResult('messaging.read', result).valid, true);
  }

  for (const result of [
    { events: [], ackToken: 'ack-1', stale: false },
    { events: [], ackToken: null, stale: false, pageToken: 'not-in-row-6' },
  ]) {
    assert.equal(validateMessagingRowResult('messaging.read', result).valid, false);
  }

  assert.equal(
    validateMessagingRowResult('messaging.snapshot', {
      items: [],
      nextPageToken: null,
      snapshotAckToken: 'snapshot-ack-1',
    }).valid,
    true,
  );
  assert.equal(
    validateMessagingRowResult('messaging.snapshot', {
      items: [],
      nextPageToken: null,
      snapshotAckToken: null,
    }).valid,
    false,
  );
});

test('nested open payloads still reject non-JSON and non-scalar values', () => {
  assert.equal(
    validateMessagingRowInput('messaging.send', {
      ...draft,
      payload: {
        ...draft.payload,
        elements: [
          { elementId: 'element-1', kind: 'rich_block', payload: { bad: '\ud800' } },
        ],
      },
    }).valid,
    false,
  );

  const recursive: Record<string, unknown> = {};
  recursive.self = recursive;
  assert.doesNotThrow(() => {
    assert.equal(
      validateMessagingRowInput('messaging.send', {
        ...draft,
        payload: {
          ...draft.payload,
          elements: [
            { elementId: 'element-1', kind: 'rich_block', payload: recursive },
          ],
        },
      }).valid,
      false,
    );
  });
});

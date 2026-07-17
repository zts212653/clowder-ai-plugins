import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  CAPABILITY_TABLE,
  type BehaviorCase,
  type BehaviorFixture,
  type Capability,
  type FixtureOperation,
} from '../generated/contract.generated.js';
import { executeBehaviorCase } from './behavior-executor.js';
import { MessagingLoopbackAdapter } from './index.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../fixtures/behavior/messaging/adversarial-invariants.json', import.meta.url),
    'utf8',
  ),
) as BehaviorFixture;

async function runCase(behaviorCase: BehaviorCase) {
  return executeBehaviorCase(behaviorCase, new MessagingLoopbackAdapter());
}

test('committed fixture covers every loopback operation family', () => {
  const operations = new Set(fixture.cases.map(({ when }) => when.operation));
  for (const operation of [
    'send',
    'appendElements',
    'read',
    'ack',
    'applyGrantPreset',
    'revokeGrant',
    'deliverOnMessage',
    'checkPermissionMatrix',
    'deleteReplayEvents',
  ] as const) {
    assert.equal(operations.has(operation), true, `${operation} must have a committed oracle`);
  }
});

for (const behaviorCase of fixture.cases) {
  test(`loopback executes ${behaviorCase.id}`, async () => {
    assert.deepEqual(await runCase(behaviorCase), {
      id: behaviorCase.id,
      passed: true,
      failures: [],
    });
  });
}

test('changing every signed error code is detected by the executor', async () => {
  const errorCases = fixture.cases.filter(({ expect }) => expect.status === 'error');
  assert.ok(errorCases.length > 0);

  for (const behaviorCase of errorCases) {
    const mutated: BehaviorCase = {
      ...structuredClone(behaviorCase),
      expect: {
        ...structuredClone(behaviorCase.expect),
        errorCode:
          behaviorCase.expect.errorCode === 'VALIDATION' ? 'PERMISSION' : 'VALIDATION',
      },
    };
    const report = await runCase(mutated);
    assert.equal(report.passed, false, behaviorCase.id);
    assert.match(report.failures.join('\n'), /errorCode/);
  }
});

test('an incomplete permission matrix fails closed', async () => {
  const behaviorCase = fixture.cases.find(({ id }) => id === 'permission-matrix-complete');
  assert.ok(behaviorCase?.when.operation === 'checkPermissionMatrix');
  const mutated: BehaviorCase = {
    ...structuredClone(behaviorCase),
    when: {
      operation: 'checkPermissionMatrix',
      input: {
        entries: behaviorCase.when.input.entries.slice(1),
      },
    },
  };

  const report = await runCase(mutated);

  assert.equal(report.passed, false);
  assert.match(report.failures.join('\n'), /status.*expected success.*received error/);
});

const subscriptionOperations: readonly FixtureOperation[] = [
  {
    operation: 'read',
    input: { subscriptionId: 'subscription-a', limit: 32 },
  },
  {
    operation: 'ack',
    input: { subscriptionId: 'subscription-a', ackToken: 'subscription-token-a' },
  },
  {
    operation: 'snapshot',
    input: { subscriptionId: 'subscription-a' },
  },
  {
    operation: 'deleteReplayEvents',
    input: { subscriptionId: 'subscription-a', throughSequence: 12 },
  },
];

const subscriptionCase = fixture.cases.find(
  ({ id }) => id === 'stale-cursor-snapshot-roundtrip',
);
assert.ok(subscriptionCase);

test('every existing-subscription operation requires the subscription grant', async () => {
  for (const operation of subscriptionOperations) {
    const adapter = new MessagingLoopbackAdapter();
    await adapter.setup({
      ...structuredClone(subscriptionCase.given),
      grants: [],
    });

    assert.deepEqual(await adapter.execute(operation), {
      status: 'error',
      errorCode: 'PERMISSION',
    }, operation.operation);
  }
});

test('every existing-subscription operation rejects a foreign caller', async () => {
  for (const operation of subscriptionOperations) {
    const adapter = new MessagingLoopbackAdapter();
    await adapter.setup({
      ...structuredClone(subscriptionCase.given),
      caller: { pluginInstanceId: 'plugin-b' },
    });

    assert.deepEqual(await adapter.execute(operation), {
      status: 'error',
      errorCode: 'PERMISSION',
    }, operation.operation);
  }
});

test('connector binding sends require caller ownership', async () => {
  const adapter = new MessagingLoopbackAdapter();
  await adapter.setup({
    caller: { pluginInstanceId: 'plugin-a' },
    grants: ['messaging.send'],
    handles: {
      binding: {
        kind: 'connector_binding',
        token: 'connector-binding-a',
        ownerPluginInstanceId: 'plugin-a',
        connectorId: 'connector-a',
        threadId: 'thread-1',
      },
    },
    state: {},
  });

  assert.deepEqual(
    await adapter.execute({
      operation: 'send',
      input: {
        address: { kind: 'connector_binding', handle: 'connector-binding-a' },
        idempotencyKey: 'connector-send-1',
        payload: {
          provenance: { epistemicStatus: 'inference' },
          elements: [
            { elementId: 'text-1', kind: 'text', payload: { text: 'hello' } },
          ],
        },
      },
    }),
    { status: 'success' },
  );
  const messages = await adapter.observe('messages');
  assert.ok(Array.isArray(messages));
  assert.equal(messages[0]?.threadId, 'thread-1');

  const foreignAdapter = new MessagingLoopbackAdapter();
  await foreignAdapter.setup({
    caller: { pluginInstanceId: 'plugin-b' },
    grants: ['messaging.send'],
    handles: {
      binding: {
        kind: 'connector_binding',
        token: 'connector-binding-a',
        ownerPluginInstanceId: 'plugin-a',
        connectorId: 'connector-a',
        threadId: 'thread-1',
      },
    },
    state: {},
  });
  assert.deepEqual(
    await foreignAdapter.execute({
      operation: 'send',
      input: {
        address: { kind: 'connector_binding', handle: 'connector-binding-a' },
        idempotencyKey: 'foreign-connector-send-1',
        payload: {
          provenance: { epistemicStatus: 'inference' },
          elements: [
            { elementId: 'text-1', kind: 'text', payload: { text: 'blocked' } },
          ],
        },
      },
    }),
    { status: 'error', errorCode: 'PERMISSION' },
  );
});

test('send rejects owned handles whose canonical thread target is unresolved', async () => {
  const unresolvedTargets = [
    {
      kind: 'thread_handle' as const,
      token: 'thread-handle-a',
      ownerPluginInstanceId: 'plugin-a',
    },
    {
      kind: 'connector_binding' as const,
      token: 'connector-binding-a',
      ownerPluginInstanceId: 'plugin-a',
      connectorId: 'connector-a',
    },
  ];

  for (const target of unresolvedTargets) {
    const adapter = new MessagingLoopbackAdapter();
    await adapter.setup({
      caller: { pluginInstanceId: 'plugin-a' },
      grants: ['messaging.send'],
      handles: { target },
      state: {},
    });

    assert.deepEqual(
      await adapter.execute({
        operation: 'send',
        input: {
          address: { kind: target.kind, handle: target.token },
          idempotencyKey: `unresolved-${target.kind}`,
          payload: {
            provenance: { epistemicStatus: 'inference' },
            elements: [
              { elementId: 'text-1', kind: 'text', payload: { text: 'blocked' } },
            ],
          },
        },
      }),
      { status: 'error', errorCode: 'NOT_FOUND' },
      target.kind,
    );
    assert.deepEqual(await adapter.observe('messages'), [], target.kind);
    assert.deepEqual(await adapter.observe('output_events'), [], target.kind);
    assert.deepEqual(await adapter.observe('idempotency_ledger'), [], target.kind);
  }
});

test('onMessage delivery requires its distinct grant and matching envelope scope', async () => {
  const operation = {
    operation: 'deliverOnMessage' as const,
    input: {
      threadHandle: 'thread-handle-a',
      envelope: { messageId: 'message-1', threadId: 'thread-1' },
    },
  };
  const setup = {
    caller: { pluginInstanceId: 'plugin-a' },
    handles: {
      target: {
        kind: 'thread_handle' as const,
        token: 'thread-handle-a',
        ownerPluginInstanceId: 'plugin-a',
        threadId: 'thread-1',
      },
    },
    state: {},
  };

  const allowed = new MessagingLoopbackAdapter();
  await allowed.setup({ ...setup, grants: ['onMessage'] });
  assert.deepEqual(await allowed.execute(operation), { status: 'success' });

  const wrongGrant = new MessagingLoopbackAdapter();
  await wrongGrant.setup({ ...setup, grants: ['message.event.subscribe'] });
  assert.deepEqual(await wrongGrant.execute(operation), {
    status: 'error',
    errorCode: 'PERMISSION',
  });

  const wrongScope = new MessagingLoopbackAdapter();
  await wrongScope.setup({ ...setup, grants: ['onMessage'] });
  assert.deepEqual(
    await wrongScope.execute({
      ...operation,
      input: {
        ...operation.input,
        envelope: { messageId: 'message-2', threadId: 'thread-2' },
      },
    }),
    { status: 'error', errorCode: 'VALIDATION' },
  );
  assert.deepEqual(await wrongScope.observe('messages'), []);
  assert.deepEqual(await wrongScope.observe('output_events'), []);
});

test('append rejects canonical messages outside the handle thread with zero mutation', async () => {
  for (const messageThreadId of [undefined, 'thread-2']) {
    const adapter = new MessagingLoopbackAdapter();
    await adapter.setup({
      caller: { pluginInstanceId: 'plugin-a' },
      grants: ['messaging.appendElements'],
      handles: {
        message: {
          kind: 'message_handle',
          token: 'message-handle-a',
          ownerPluginInstanceId: 'plugin-a',
          threadId: 'thread-1',
          messageId: 'message-1',
        },
      },
      state: {
        messages: [
          {
            messageId: 'message-1',
            ...(messageThreadId === undefined ? {} : { threadId: messageThreadId }),
            revision: 1,
          },
        ],
      },
    });

    const before = await adapter.observe('messages');
    assert.deepEqual(
      await adapter.execute({
        operation: 'appendElements',
        input: {
          handle: { kind: 'message', token: 'message-handle-a' },
          operationId: 'cross-thread-append-1',
          elements: [
            { elementId: 'text-1', kind: 'text', payload: { text: 'blocked' } },
          ],
        },
      }),
      { status: 'error', errorCode: 'VALIDATION' },
      String(messageThreadId),
    );
    assert.deepEqual(await adapter.observe('messages'), before);
    assert.deepEqual(await adapter.observe('output_events'), []);
    assert.deepEqual(await adapter.observe('idempotency_ledger'), []);
  }
});

test('first-party presets accept exactly the schema-owned L1 capabilities', async () => {
  const rejected = [
    ...CAPABILITY_TABLE.L0,
    ...CAPABILITY_TABLE.L2,
  ] as readonly Capability[];
  for (const capability of rejected) {
    const adapter = new MessagingLoopbackAdapter();
    await adapter.setup({
      caller: { pluginInstanceId: 'first-party-plugin' },
      grants: [],
      handles: {},
      state: { grantState: {} },
    });
    assert.deepEqual(
      await adapter.execute({
        operation: 'applyGrantPreset',
        input: { presetKind: 'first_party', capabilities: [capability] },
      }),
      { status: 'error', errorCode: 'PERMISSION' },
      capability,
    );
    assert.deepEqual(await adapter.observe('grant_state'), {}, capability);
  }

  const allowed = new MessagingLoopbackAdapter();
  await allowed.setup({
    caller: { pluginInstanceId: 'first-party-plugin' },
    grants: [],
    handles: {},
    state: { grantState: {} },
  });
  assert.deepEqual(
    await allowed.execute({
      operation: 'applyGrantPreset',
      input: {
        presetKind: 'first_party',
        capabilities: CAPABILITY_TABLE.L1,
      },
    }),
    { status: 'success' },
  );
  assert.deepEqual(
    await allowed.observe('grant_state'),
    Object.fromEntries(
      CAPABILITY_TABLE.L1.map((capability) => [
        capability,
        { visible: true, granted: true },
      ]),
    ),
  );
});

test('subscribe resolves and preserves the canonical handle thread', async () => {
  const unresolved = new MessagingLoopbackAdapter();
  await unresolved.setup({
    caller: { pluginInstanceId: 'plugin-a' },
    grants: ['message.event.subscribe'],
    handles: {
      target: {
        kind: 'thread_handle',
        token: 'thread-handle-a',
        ownerPluginInstanceId: 'plugin-a',
      },
    },
    state: {},
  });
  assert.deepEqual(
    await unresolved.execute({
      operation: 'subscribe',
      input: { handleId: 'thread-handle-a' },
    }),
    { status: 'error', errorCode: 'NOT_FOUND' },
  );
  assert.equal(await unresolved.observe('subscription'), undefined);

  const scoped = new MessagingLoopbackAdapter();
  await scoped.setup({
    caller: { pluginInstanceId: 'plugin-a' },
    grants: ['message.event.subscribe'],
    handles: {
      target: {
        kind: 'thread_handle',
        token: 'thread-handle-a',
        ownerPluginInstanceId: 'plugin-a',
        threadId: 'thread-1',
      },
    },
    state: {},
  });
  assert.deepEqual(
    await scoped.execute({
      operation: 'subscribe',
      input: { handleId: 'thread-handle-a' },
    }),
    { status: 'success' },
  );
  assert.deepEqual(await scoped.observe('subscription'), {
    subscriptionId: 'loopback-subscription-1',
    ownerPluginInstanceId: 'plugin-a',
    threadId: 'thread-1',
    cursorSequence: 0,
    ackedSequence: 0,
  });
});

test('replay deletion is scoped to the authorized subscription', async () => {
  const adapter = new MessagingLoopbackAdapter();
  await adapter.setup({
    caller: { pluginInstanceId: 'plugin-a' },
    grants: ['message.event.subscribe'],
    handles: {
      subscriptionA: {
        kind: 'subscription',
        token: 'subscription-token-a',
        ownerPluginInstanceId: 'plugin-a',
        threadId: 'thread-1',
        subscriptionId: 'subscription-a',
      },
      subscriptionB: {
        kind: 'subscription',
        token: 'subscription-token-b',
        ownerPluginInstanceId: 'plugin-a',
        threadId: 'thread-2',
        subscriptionId: 'subscription-b',
      },
    },
    state: {
      replayEvents: [
        { eventId: 'event-a-1', subscriptionId: 'subscription-a', sequence: 1 },
        { eventId: 'event-a-2', subscriptionId: 'subscription-a', sequence: 2 },
        { eventId: 'event-b-1', subscriptionId: 'subscription-b', sequence: 1 },
        { eventId: 'event-unscoped', sequence: 1 },
      ],
    },
  });

  assert.deepEqual(
    await adapter.execute({
      operation: 'deleteReplayEvents',
      input: { subscriptionId: 'subscription-a', throughSequence: 1 },
    }),
    { status: 'success' },
  );
  assert.deepEqual(await adapter.observe('replay_events'), [
    { eventId: 'event-a-2', subscriptionId: 'subscription-a', sequence: 2 },
    { eventId: 'event-b-1', subscriptionId: 'subscription-b', sequence: 1 },
    { eventId: 'event-unscoped', sequence: 1 },
  ]);
});

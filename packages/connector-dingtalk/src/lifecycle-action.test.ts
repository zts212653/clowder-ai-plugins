import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';

import { createConnectorLifecycleAction, type ConnectorLifecycleCallbacks } from './lifecycle-action.js';

function harness(placeholderId = 'placeholder-1') {
  const state = new Map<string, { revision: number; value: unknown }>();
  const calls: unknown[][] = [];
  const context = {
    storage: {
      get: async (key: string) => state.get(key),
      set: async (key: string, value: unknown) => {
        const revision = (state.get(key)?.revision ?? 0) + 1;
        state.set(key, { revision, value });
        return { revision };
      },
    },
    threads: {
      listBindings: async () => [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }],
    },
    log() {},
  } as unknown as FeatureContext;
  const callbacks: ConnectorLifecycleCallbacks = {
    async sendPlaceholder(...args) { calls.push(['sendPlaceholder', ...args]); return placeholderId; },
    async editPlaceholder(...args) { calls.push(['editPlaceholder', ...args]); return true; },
    async sendRecovery(...args) { calls.push(['sendRecovery', ...args]); },
    async settle(input) { calls.push(['settle', input]); },
  };
  return { action: createConnectorLifecycleAction(context, callbacks), calls, context, state };
}

const presentation = {
  actor: { displayName: '砚砚', emoji: '🐱' },
  thread: { shortId: 'thread-1' },
} as const;

test('Gate L accepts repeated catching-up deliveries and replays without duplicate provider effects', async () => {
  const { action, calls } = harness();
  const events = [
    { lifecycleId: 'life-1', deliveryId: 'delivery-1', threadId: 'thread-1', state: 'started', presentation },
    { lifecycleId: 'life-1', deliveryId: 'delivery-2', threadId: 'thread-1', state: 'catching_up' },
    { lifecycleId: 'life-1', deliveryId: 'delivery-3', threadId: 'thread-1', state: 'catching_up' },
    { lifecycleId: 'life-1', deliveryId: 'delivery-4', threadId: 'thread-1', state: 'settled', chainDone: true, outcome: 'completed' },
  ] as const;
  for (const event of events) assert.deepEqual(await action(event), { deliveryId: event.deliveryId });
  assert.deepEqual(await action(events[2]), { deliveryId: 'delivery-3' });
  assert.deepEqual(calls, [
    ['sendPlaceholder', 'chat-1', '【砚砚🐱】🤔 思考中...'],
    ['editPlaceholder', 'chat-1', 'placeholder-1', '🔄 收到新消息，正在重新整理回复…', 'catching_up', 'life-1'],
    ['editPlaceholder', 'chat-1', 'placeholder-1', '🔄 收到新消息，正在重新整理回复…', 'catching_up', 'life-1'],
    ['settle', {
      externalConversationId: 'chat-1', platformMessageId: 'placeholder-1', actorDisplayName: '砚砚', event: events[3],
    }],
  ]);
});

test('Gate L rejects catching-up and a second blocked event after blocked, then accepts settled', async () => {
  const { action, calls } = harness();
  const started = { lifecycleId: 'life-2', deliveryId: 'delivery-1', threadId: 'thread-1', state: 'started', presentation } as const;
  const blocked = {
    lifecycleId: 'life-2', deliveryId: 'delivery-2', threadId: 'thread-1', state: 'blocked',
    reason: 'needs_user', recoveryUrl: 'https://app.example/thread/thread-1',
  } as const;
  await action(started);
  await action(blocked);
  await assert.rejects(
    action({ lifecycleId: 'life-2', deliveryId: 'delivery-3', threadId: 'thread-1', state: 'catching_up' }),
    (error: unknown) => (error as { code?: string }).code === 'LIFECYCLE_OUT_OF_ORDER',
  );
  await assert.rejects(
    action({ ...blocked, deliveryId: 'delivery-4' }),
    (error: unknown) => (error as { code?: string }).code === 'LIFECYCLE_OUT_OF_ORDER',
  );
  assert.deepEqual(await action({
    lifecycleId: 'life-2', deliveryId: 'delivery-5', threadId: 'thread-1', state: 'settled',
    chainDone: false, outcome: 'failed',
  }), { deliveryId: 'delivery-5' });
  assert.equal(calls.filter(call => call[0] === 'editPlaceholder').length, 1);
  assert.deepEqual(calls[1], [
    'editPlaceholder', 'chat-1', 'placeholder-1',
    '⚠️ 未能完成最新消息重读（needs_user）。请打开 Clowder AI 重试：https://app.example/thread/thread-1',
    'blocked',
    'life-2',
  ]);
  assert.deepEqual(calls.at(-1), ['settle', {
    externalConversationId: 'chat-1',
    platformMessageId: 'placeholder-1',
    actorDisplayName: '砚砚',
    recoveryText: '⚠️ 未能完成最新消息重读（needs_user）。请打开 Clowder AI 重试：https://app.example/thread/thread-1',
    event: {
      lifecycleId: 'life-2', deliveryId: 'delivery-5', threadId: 'thread-1', state: 'settled',
      chainDone: false, outcome: 'failed',
    },
  }]);
});

test('Gate L sends exactly one standalone recovery when no placeholder id exists', async () => {
  const { action, calls } = harness('');
  const started = { lifecycleId: 'life-3', deliveryId: 'delivery-1', threadId: 'thread-1', state: 'started', presentation } as const;
  const blocked = {
    lifecycleId: 'life-3', deliveryId: 'delivery-2', threadId: 'thread-1', state: 'blocked', reason: 'timeout',
  } as const;
  await action(started);
  await action(blocked);
  await action(blocked);
  assert.deepEqual(calls.filter(call => call[0] === 'sendRecovery'), [[
    'sendRecovery', 'chat-1', '⚠️ 未能完成最新消息重读（timeout）。请打开 Clowder AI 重试。',
  ]]);
});

test('Gate L falls back to exactly one standalone recovery after provider session loss', async () => {
  const first = harness();
  await first.action({
    lifecycleId: 'life-4', deliveryId: 'delivery-1', threadId: 'thread-1', state: 'started', presentation,
  });

  const calls: unknown[][] = [];
  const restarted = createConnectorLifecycleAction(first.context, {
    async sendPlaceholder() { throw new Error('unexpected placeholder'); },
    async editPlaceholder(...args) { calls.push(['editPlaceholder', ...args]); return false; },
    async sendRecovery(...args) { calls.push(['sendRecovery', ...args]); },
    async settle(input) { calls.push(['settle', input]); },
  });
  const blocked = {
    lifecycleId: 'life-4', deliveryId: 'delivery-2', threadId: 'thread-1', state: 'blocked', reason: 'timeout',
  } as const;
  await restarted(blocked);
  await restarted(blocked);

  assert.deepEqual(calls, [
    ['editPlaceholder', 'chat-1', 'placeholder-1', '⚠️ 未能完成最新消息重读（timeout）。请打开 Clowder AI 重试。', 'blocked', 'life-4'],
    ['sendRecovery', 'chat-1', '⚠️ 未能完成最新消息重读（timeout）。请打开 Clowder AI 重试。'],
  ]);
});

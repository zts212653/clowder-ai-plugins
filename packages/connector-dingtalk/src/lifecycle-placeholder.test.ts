import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';

import { createConnectorLifecycleAction, type ConnectorLifecycleCallbacks } from './lifecycle-action.js';

function harness(options?: {
  placeholderId?: string;
  resolveName?: (replyTo: string) => Promise<string | undefined>;
}) {
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
    async sendPlaceholder(...args) { calls.push(['sendPlaceholder', ...args]); return options?.placeholderId ?? 'placeholder-1'; },
    async editPlaceholder(...args) { calls.push(['editPlaceholder', ...args]); return true; },
    async sendRecovery(...args) { calls.push(['sendRecovery', ...args]); },
    async settle(input) { calls.push(['settle', input]); },
    ...(options?.resolveName === undefined ? {} : { resolveReplySenderName: options.resolveName }),
  };
  return { action: createConnectorLifecycleAction(context, callbacks), calls };
}

function presentation(displayName: string) {
  return { actor: { displayName, emoji: '🐱' }, thread: { shortId: 'thread-1' } };
}

function started(overrides: Record<string, unknown> = {}) {
  return {
    lifecycleId: 'life-1', deliveryId: 'delivery-1', threadId: 'thread-1', state: 'started',
    presentation: presentation('砚砚'),
    ...overrides,
  };
}

test('started without placeholderLine keeps the v1 placeholder byte-for-byte and never resolves a sender', async () => {
  const { action, calls } = harness({
    resolveName: async () => { throw new Error('resolveReplySenderName must not be called without replyTo'); },
  });
  await action(started());
  assert.deepEqual(calls, [['sendPlaceholder', 'chat-1', '【砚砚🐱】🤔 思考中...']]);
});

test('started with placeholderLine and no replyTo uses the receipt line verbatim', async () => {
  const { action, calls } = harness();
  await action(started({ placeholderLine: '收到，马上处理…' }));
  assert.deepEqual(calls, [['sendPlaceholder', 'chat-1', '【砚砚🐱】收到，马上处理…']]);
});

test('started replyTo with a recorded sender name appends the →suffix', async () => {
  const { action, calls } = harness({
    resolveName: async (replyTo: string) => (replyTo === 'host-message-1' ? '张三' : undefined),
  });
  await action(started({ placeholderLine: 'Working on it…', replyTo: 'host-message-1' }));
  assert.deepEqual(calls, [['sendPlaceholder', 'chat-1', '【砚砚🐱→张三】Working on it…']]);
});

test('started replyTo without a sender name adds no suffix', async () => {
  const { action, calls } = harness({ resolveName: async () => undefined });
  await action(started({ placeholderLine: 'Working on it…', replyTo: 'host-message-1' }));
  assert.deepEqual(calls, [['sendPlaceholder', 'chat-1', '【砚砚🐱】Working on it…']]);
});

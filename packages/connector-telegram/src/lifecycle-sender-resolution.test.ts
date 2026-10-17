import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';

import { createConnectorLifecycleAction, type ConnectorLifecycleCallbacks } from './lifecycle-action.js';

function harness(options?: {
  resolveName?: (replyTo: string) => Promise<string | undefined>;
}) {
  const state = new Map<string, { revision: number; value: unknown }>();
  const calls: unknown[][] = [];
  const warnings: unknown[][] = [];
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
    log(level: string, message: string, fields?: unknown) { warnings.push([level, message, fields]); },
  } as unknown as FeatureContext;
  const callbacks: ConnectorLifecycleCallbacks = {
    async sendPlaceholder(...args) { calls.push(['sendPlaceholder', ...args]); return 'placeholder-1'; },
    async editPlaceholder(...args) { calls.push(['editPlaceholder', ...args]); return true; },
    async sendRecovery(...args) { calls.push(['sendRecovery', ...args]); },
    async settle(input) { calls.push(['settle', input]); },
    ...(options?.resolveName === undefined ? {} : { resolveReplySenderName: options.resolveName }),
  };
  return { action: createConnectorLifecycleAction(context, callbacks), calls, warnings };
}

function started(overrides: Record<string, unknown> = {}) {
  return {
    lifecycleId: 'life-1', deliveryId: 'delivery-1', threadId: 'thread-1', state: 'started',
    presentation: { actor: { displayName: '砚砚', emoji: '🐱' }, thread: { shortId: 'thread-1' } },
    ...overrides,
  };
}

test('started replyTo with a throwing resolveReplySenderName still sends the placeholder without suffix', async () => {
  const { action, calls, warnings } = harness({
    resolveName: async () => { throw new Error('boom'); },
  });
  await action(started({ replyTo: 'host-message-1' }));
  assert.deepEqual(calls, [['sendPlaceholder', 'chat-1', '【砚砚🐱】🤔 思考中...']]);
  assert.equal(warnings.length, 1);
  assert.equal((warnings[0] as unknown[])[0], 'warn');
});

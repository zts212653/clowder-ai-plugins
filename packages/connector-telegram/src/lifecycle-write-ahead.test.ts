import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';

import { createConnectorLifecycleAction, type ConnectorLifecycleCallbacks } from './lifecycle-action.js';

function harness(options?: {
  failSet?: (callIndex: number) => Error | undefined;
}) {
  const state = new Map<string, { revision: number; value: unknown }>();
  const calls: unknown[][] = [];
  const warnings: unknown[][] = [];
  let setCalls = 0;
  const context = {
    storage: {
      get: async (key: string) => state.get(key),
      set: async (key: string, value: unknown) => {
        setCalls += 1;
        const failure = options?.failSet?.(setCalls);
        if (failure !== undefined) throw failure;
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
  };
  return { action: createConnectorLifecycleAction(context, callbacks), calls, warnings, state };
}

function started(overrides: Record<string, unknown> = {}) {
  return {
    lifecycleId: 'life-1', deliveryId: 'delivery-1', threadId: 'thread-1', state: 'started',
    presentation: { actor: { displayName: '砚砚', emoji: '🐱' }, thread: { shortId: 'thread-1' } },
    ...overrides,
  };
}

test('pre-write failure after the retry throws PLUGIN_INTERNAL before any platform side effect', async () => {
  const { action, calls, state } = harness({ failSet: () => new Error('storage down') });
  await assert.rejects(action(started()), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code?: string }).code, 'PLUGIN_INTERNAL');
    return true;
  });
  assert.deepEqual(calls, []);
  assert.equal(state.size, 0);
});

test('post-write failure warns, does not throw, and a Host replay answers replay without re-sending', async () => {
  const event = started();
  const { action, calls, warnings } = harness({
    failSet: (callIndex) => (callIndex === 2 ? new Error('post-write boom') : undefined),
  });
  const first = await action(event);
  assert.deepEqual(first, { deliveryId: 'delivery-1' });
  assert.equal(calls.filter(call => call[0] === 'sendPlaceholder').length, 1);
  assert.ok(warnings.some(warning => warning[1] === 'Connector lifecycle state post-write failed'));

  const replay = await action(event);
  assert.deepEqual(replay, { deliveryId: 'delivery-1' });
  assert.equal(calls.filter(call => call[0] === 'sendPlaceholder').length, 1);
});

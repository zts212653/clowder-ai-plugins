import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';

import { createConnectorLifecycleAction, type ConnectorLifecycleCallbacks } from './lifecycle-action.js';

type Action = ReturnType<typeof createConnectorLifecycleAction>;

function harness(state: Map<string, { revision: number; value: unknown }>) {
  const calls: unknown[][] = [];
  const context = {
    storage: {
      get: async (key: string) => state.get(key),
      list: async () => Object.fromEntries(state),
      set: async (key: string, value: unknown) => {
        const revision = (state.get(key)?.revision ?? 0) + 1;
        state.set(key, { revision, value });
        return { revision };
      },
      delete: async (key: string, expectedRevision?: number) => {
        calls.push(['delete', key, expectedRevision]);
        const entry = state.get(key);
        if (entry === undefined || (expectedRevision !== undefined && entry.revision !== expectedRevision)) {
          return { deleted: false };
        }
        state.delete(key);
        return { deleted: true };
      },
    },
    threads: {
      listBindings: async () => [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }],
    },
    log() {},
  } as unknown as FeatureContext;
  const callbacks: ConnectorLifecycleCallbacks = {
    async sendPlaceholder(...args) { calls.push(['sendPlaceholder', ...args]); return 'placeholder-1'; },
    async editPlaceholder(...args) { calls.push(['editPlaceholder', ...args]); return true; },
    async sendRecovery(...args) { calls.push(['sendRecovery', ...args]); },
    async settle(input) { calls.push(['settle', input]); },
  };
  return { action: createConnectorLifecycleAction(context, callbacks), calls };
}

function started(overrides: Record<string, unknown> = {}) {
  return {
    lifecycleId: 'life-1', deliveryId: 'delivery-1', threadId: 'thread-1', state: 'started',
    presentation: { actor: { displayName: '砚砚', emoji: '🐱' }, thread: { shortId: 'thread-1' } },
    ...overrides,
  };
}

async function settleLifecycle(action: Action) {
  await action(started());
  await action({ lifecycleId: 'life-1', deliveryId: 'delivery-2', threadId: 'thread-1', state: 'blocked', reason: 'needs_user' });
  await action({
    lifecycleId: 'life-1', deliveryId: 'delivery-3', threadId: 'thread-1', state: 'settled',
    chainDone: false, outcome: 'failed',
  });
}

test('settled lifecycle compresses into a v2 tombstone retaining the full event history', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  const { action } = harness(state);
  await settleLifecycle(action);
  const record = state.get('lifecycle/life-1')?.value as Record<string, unknown>;
  assert.equal(record.version, 2);
  assert.equal(record.tombstone, true);
  assert.deepEqual((record.history as Record<string, unknown>[]).map(event => event.state), ['started', 'blocked', 'settled']);
  assert.equal(record.platformMessageId, 'placeholder-1');
  assert.equal(typeof record.settledAt, 'number');
  assert.deepEqual(record.deliveryIds, ['delivery-1', 'delivery-2', 'delivery-3']);
});

test('redelivered settled event after tombstone is still answered as replay', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  const { action, calls } = harness(state);
  await settleLifecycle(action);
  const settleCalls = calls.filter(call => call[0] === 'settle').length;
  const replayed = await action({
    lifecycleId: 'life-1', deliveryId: 'delivery-3', threadId: 'thread-1', state: 'settled',
    chainDone: false, outcome: 'failed',
  });
  assert.deepEqual(replayed, { deliveryId: 'delivery-3' });
  assert.equal(calls.filter(call => call[0] === 'settle').length, settleCalls);
});

test('exact redelivery of an accepted pre-settle deliveryId after tombstone is answered as replay', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  const { action, calls } = harness(state);
  await settleLifecycle(action);
  const effectCalls = calls.length;
  const replayed = await action(started());
  assert.deepEqual(replayed, { deliveryId: 'delivery-1' });
  assert.equal(calls.length, effectCalls, 'a replay must not re-run platform side effects');
});

test('same deliveryId with different content after tombstone is rejected DELIVERY_CONFLICT', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  const { action, calls } = harness(state);
  await settleLifecycle(action);
  const effectCalls = calls.length;
  await assert.rejects(
    action({
      lifecycleId: 'life-1', deliveryId: 'delivery-3', threadId: 'thread-1', state: 'settled',
      chainDone: true, outcome: 'completed',
    }),
    (error: unknown) => {
      assert.equal((error as Error & { code?: string }).code, 'LIFECYCLE_DELIVERY_CONFLICT');
      return true;
    },
  );
  assert.equal(calls.length, effectCalls, 'a rejected redelivery must not re-run platform side effects');
});

test('started deliveryId re-sent as a different state after tombstone is rejected DELIVERY_CONFLICT', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  const { action } = harness(state);
  await settleLifecycle(action);
  await assert.rejects(
    action({ lifecycleId: 'life-1', deliveryId: 'delivery-1', threadId: 'thread-1', state: 'catching_up' }),
    (error: unknown) => {
      assert.equal((error as Error & { code?: string }).code, 'LIFECYCLE_DELIVERY_CONFLICT');
      return true;
    },
  );
});

test('late non-settled event after tombstone is rejected OUT_OF_ORDER', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  const { action } = harness(state);
  await settleLifecycle(action);
  await assert.rejects(
    action({ lifecycleId: 'life-1', deliveryId: 'delivery-9', threadId: 'thread-1', state: 'catching_up' }),
    (error: unknown) => {
      assert.equal((error as Error & { code?: string }).code, 'LIFECYCLE_OUT_OF_ORDER');
      return true;
    },
  );
});

test('sweep deletes expired tombstones and stranded records but keeps fresh ones', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  const { action, calls } = harness(state);
  const now = Date.now();
  const settledEvent = {
    lifecycleId: 'old-settled', deliveryId: 'd-1', threadId: 'thread-1', state: 'settled', chainDone: true, outcome: 'completed',
  };
  state.set('lifecycle/old-settled', {
    revision: 1,
    value: {
      version: 2, tombstone: true, history: [settledEvent], actorDisplayName: '砚砚',
      updatedAt: now - 25 * 60 * 60 * 1000, settledAt: now - 25 * 60 * 60 * 1000,
    },
  });
  state.set('lifecycle/stranded', {
    revision: 1,
    value: {
      version: 2, history: [started({ lifecycleId: 'stranded' })], actorDisplayName: '砚砚',
      updatedAt: now - 25 * 60 * 60 * 1000,
    },
  });
  state.set('lifecycle/fresh', {
    revision: 1,
    value: {
      version: 2, history: [started({ lifecycleId: 'fresh' })], actorDisplayName: '砚砚', updatedAt: now,
    },
  });
  await action.sweepNow();
  assert.equal(state.has('lifecycle/old-settled'), false);
  assert.equal(state.has('lifecycle/stranded'), false);
  assert.equal(state.has('lifecycle/fresh'), true);
  const deletes = calls.filter(call => call[0] === 'delete');
  assert.deepEqual(deletes, [
    ['delete', 'lifecycle/old-settled', 1],
    ['delete', 'lifecycle/stranded', 1],
  ], 'sweep must delete with the revision observed in list() so a rewritten record survives');
});

test('version 1 records without updatedAt are still readable and never swept', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  const { action, calls } = harness(state);
  state.set('lifecycle/life-1', {
    revision: 1,
    value: {
      version: 1,
      history: [started()],
      platformMessageId: 'placeholder-0',
      actorDisplayName: '砚砚',
    },
  });
  await action({ lifecycleId: 'life-1', deliveryId: 'delivery-2', threadId: 'thread-1', state: 'catching_up' });
  assert.deepEqual(calls, [['editPlaceholder', 'chat-1', 'placeholder-0', '🔄 收到新消息，正在重新整理回复…', 'catching_up', 'life-1']]);
  await action.sweepNow();
  assert.equal(state.has('lifecycle/life-1'), true, 'v1 records have no updatedAt and must not be swept');
});

const RECOVERY_TEXT = '⚠️ 未能完成最新消息重读（needs_user）。请打开 Clowder AI 重试。';

test('pre-history tombstone (deliveryIds only) still answers a known deliveryId as replay without effects', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  const { action, calls } = harness(state);
  // The oldest tombstones predate full-history retention, but real v2
  // tombstones always kept the settled event in history; the accepted
  // deliveryId set remains the replay identity for deliveries predating it.
  state.set('lifecycle/legacy', {
    revision: 1,
    value: {
      version: 2, tombstone: true,
      history: [{ lifecycleId: 'legacy', deliveryId: 'delivery-3', threadId: 'thread-1', state: 'settled', chainDone: false, outcome: 'failed' }],
      deliveryIds: ['delivery-1', 'delivery-2', 'delivery-3'],
      actorDisplayName: '砚砚', settledAt: Date.now(),
    },
  });
  const effectCalls = calls.length;
  const replayed = await action(started({ lifecycleId: 'legacy' }));
  assert.deepEqual(replayed, { deliveryId: 'delivery-1' });
  assert.equal(calls.length, effectCalls, 'the fallback replay answer must not re-run platform effects');

  await assert.rejects(
    action({ lifecycleId: 'legacy', deliveryId: 'delivery-9', threadId: 'thread-1', state: 'catching_up' }),
    (error: unknown) => {
      assert.equal((error as Error & { code?: string }).code, 'LIFECYCLE_OUT_OF_ORDER');
      return true;
    },
  );
});

test('tombstone redelivery re-executes only when the pending-effect state matches the replayed event', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  const { action, calls } = harness(state);
  const settledEvent = {
    lifecycleId: 'life-1', deliveryId: 'delivery-3', threadId: 'thread-1', state: 'settled',
    chainDone: false, outcome: 'failed',
  };
  const blockedEvent = { lifecycleId: 'life-1', deliveryId: 'delivery-2', threadId: 'thread-1', state: 'blocked', reason: 'needs_user' };
  // Crash residue on a settled tombstone: the settle effect was accepted but
  // may never have run, so the record still carries a settled pending marker.
  state.set('lifecycle/life-1', {
    revision: 1,
    value: {
      version: 2, tombstone: true, history: [started(), blockedEvent, settledEvent],
      deliveryIds: ['delivery-1', 'delivery-2', 'delivery-3'],
      actorDisplayName: '砚砚', platformMessageId: 'placeholder-1', settledAt: Date.now(),
      pendingEffect: { v: 1, state: 'settled', recoveryText: RECOVERY_TEXT },
    },
  });

  // While the settled marker is still pending, a replayed blocked event has a
  // different state: it must neither re-run an effect nor clear the marker.
  await action(blockedEvent);
  assert.equal(calls.filter(call => call[0] === 'settle').length, 0);
  assert.equal(calls.filter(call => call[0] === 'editPlaceholder').length, 0);
  assert.equal(calls.filter(call => call[0] === 'sendRecovery').length, 0);
  let record = state.get('lifecycle/life-1')?.value as Record<string, unknown>;
  assert.deepEqual(record.pendingEffect, { v: 1, state: 'settled', recoveryText: RECOVERY_TEXT });

  await action(settledEvent);
  const settlements = calls.filter(call => call[0] === 'settle');
  assert.equal(settlements.length, 1, 'the matching settled replay re-runs the settlement once');
  assert.equal((settlements[0][1] as Record<string, unknown>).recoveryText, RECOVERY_TEXT);
  record = state.get('lifecycle/life-1')?.value as Record<string, unknown>;
  assert.equal(record.pendingEffect, undefined, 'the marker is cleared after the re-execution attempt');

  // The blocked replay arrives again after the marker cleared: still nothing.
  await action(blockedEvent);
  assert.equal(calls.filter(call => call[0] === 'settle').length, 1);
  assert.equal(calls.filter(call => call[0] === 'editPlaceholder').length, 0);
  assert.equal(calls.filter(call => call[0] === 'sendRecovery').length, 0);
});

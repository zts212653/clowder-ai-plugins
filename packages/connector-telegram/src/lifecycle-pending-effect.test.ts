import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';

import { createConnectorLifecycleAction, type ConnectorLifecycleCallbacks } from './lifecycle-action.js';

// Crash simulation: storage snapshots every accepted write, so a test can
// rewind the map to the pre-write of a transition (marker present, platform
// effect never ran — the process died in between) and redeliver the same
// deliveryId through a fresh action instance, exactly what the Host does.
function harness(options?: { withPlaceholder?: boolean }) {
  const state = new Map<string, { revision: number; value: unknown }>();
  const writes: Array<{ key: string; value: unknown }> = [];
  const calls: unknown[][] = [];
  const logs: unknown[][] = [];
  const context = {
    storage: {
      get: async (key: string) => state.get(key),
      set: async (key: string, value: unknown) => {
        writes.push({ key, value: structuredClone(value) });
        const revision = (state.get(key)?.revision ?? 0) + 1;
        state.set(key, { revision, value });
        return { revision };
      },
    },
    threads: {
      listBindings: async () => [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }],
    },
    log(...args: unknown[]) { logs.push(args); },
  } as unknown as FeatureContext;
  const callbacks: ConnectorLifecycleCallbacks = {
    async sendPlaceholder(...args) {
      calls.push(['sendPlaceholder', ...args]);
      return options?.withPlaceholder === false ? '' : 'placeholder-1';
    },
    async editPlaceholder(...args) { calls.push(['editPlaceholder', ...args]); return true; },
    async sendRecovery(...args) { calls.push(['sendRecovery', ...args]); },
    async settle(input) { calls.push(['settle', input]); },
  };
  return {
    state,
    writes,
    calls,
    logs,
    context,
    callbacks,
    action: createConnectorLifecycleAction(context, callbacks),
    // Rewind storage to a captured write and restart the action, simulating
    // a process crash after that write with a fresh in-memory runtime.
    rewindTo(write: { key: string; value: unknown }) {
      const revision = (state.get(write.key)?.revision ?? 0) + 1;
      state.set(write.key, { revision, value: structuredClone(write.value) });
      calls.length = 0;
      return createConnectorLifecycleAction(context, callbacks);
    },
  };
}

const RECOVERY_TEXT = '⚠️ 未能完成最新消息重读（needs_user）。请打开 Clowder AI 重试。';

function started() {
  return {
    lifecycleId: 'life-1', deliveryId: 'delivery-1', threadId: 'thread-1', state: 'started',
    presentation: { actor: { displayName: '砚砚', emoji: '🐱' }, thread: { shortId: 'thread-1' } },
  };
}

function blocked() {
  return { lifecycleId: 'life-1', deliveryId: 'delivery-2', threadId: 'thread-1', state: 'blocked', reason: 'needs_user' };
}

function settled() {
  return { lifecycleId: 'life-1', deliveryId: 'delivery-3', threadId: 'thread-1', state: 'settled', chainDone: false, outcome: 'failed' };
}

function recordOf(h: ReturnType<typeof harness>): Record<string, unknown> {
  return h.state.get('lifecycle/life-1')?.value as Record<string, unknown>;
}

test('blocked pre-write carries the pending-effect marker and the post-write clears it', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  const blockedPre = h.writes.find(write => (
    (write.value as Record<string, unknown>).pendingEffect !== undefined
    && ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown>).state === 'blocked'
  ));
  assert.ok(blockedPre, 'blocked pre-write must carry the pending-effect marker');
  assert.deepEqual(blockedPre.value, {
    ...(blockedPre.value as Record<string, unknown>),
    // pinned marker shape: small, versioned, names the pending effect
    pendingEffect: { v: 1, state: 'blocked', recoveryText: RECOVERY_TEXT },
  });
  assert.equal(recordOf(h).pendingEffect, undefined, 'post-write clears the marker');
});

test('crash before the blocked effect (no placeholder): redelivery re-executes the recovery send exactly once', async () => {
  const h = harness({ withPlaceholder: false });
  await h.action(started());
  await h.action(blocked());
  const blockedPre = h.writes.find(write => (
    ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown> | undefined)?.state === 'blocked'
  ));
  assert.ok(blockedPre);
  // Rewind to the blocked pre-write: state accepted, recovery send never ran.
  const redelivered = h.rewindTo(blockedPre);

  const first = await redelivered(blocked());
  assert.deepEqual(first, { deliveryId: 'delivery-2' });
  const recoverySends = h.calls.filter(call => call[0] === 'sendRecovery');
  assert.equal(recoverySends.length, 1, 'the re-executed recovery hint is delivered exactly once');
  assert.deepEqual(recoverySends[0], ['sendRecovery', 'chat-1', RECOVERY_TEXT]);
  assert.equal(recordOf(h).pendingEffect, undefined, 're-execution clears the marker');

  const second = await redelivered(blocked());
  assert.deepEqual(second, { deliveryId: 'delivery-2' });
  assert.equal(h.calls.filter(call => call[0] === 'sendRecovery').length, 1, 'a further redelivery does not duplicate the hint');
});

test('crash before the blocked effect (placeholder present): redelivery re-executes the blocked edit once, no recovery send', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  const blockedPre = h.writes.find(write => (
    ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown> | undefined)?.state === 'blocked'
  ));
  assert.ok(blockedPre);
  const redelivered = h.rewindTo(blockedPre);

  await redelivered(blocked());
  assert.equal(h.calls.filter(call => call[0] === 'editPlaceholder').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'sendRecovery').length, 0, 'an editable placeholder keeps the edit fallback');
  await redelivered(blocked());
  assert.equal(h.calls.filter(call => call[0] === 'editPlaceholder').length, 1);
});

test('crash before the settle effect: tombstone redelivery re-runs settle with the recovery text exactly once', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  await h.action(settled());
  const settledPre = h.writes.find(write => (
    ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown> | undefined)?.state === 'settled'
  ));
  assert.ok(settledPre, 'settle-with-recovery-text pre-write carries the marker');
  const redelivered = h.rewindTo(settledPre);

  await redelivered(settled());
  const settlements = h.calls.filter(call => call[0] === 'settle');
  assert.equal(settlements.length, 1, 'the re-executed settlement runs exactly once');
  assert.equal((settlements[0][1] as Record<string, unknown>).recoveryText, RECOVERY_TEXT);
  assert.equal((settlements[0][1] as Record<string, unknown>).platformMessageId, 'placeholder-1');
  assert.equal(recordOf(h).pendingEffect, undefined);

  await redelivered(settled());
  assert.equal(h.calls.filter(call => call[0] === 'settle').length, 1, 'a further redelivery does not re-run settle');

  // A redelivery of the earlier blocked delivery on the same tombstone is a
  // plain replay: the settled marker must not trigger effects for it.
  await redelivered(blocked());
  assert.equal(h.calls.filter(call => call[0] === 'settle').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'sendRecovery').length, 0);
});

test('settle arriving while a blocked marker is pending flushes the recovery effect before settling', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  const blockedPre = h.writes.find(write => (
    ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown> | undefined)?.state === 'blocked'
  ));
  assert.ok(blockedPre);
  // The Host never redelivers blocked; it moves on to settle. The marker must
  // not be silently overwritten — the recovery effect flushes first.
  const resumed = h.rewindTo(blockedPre);

  await resumed(settled());
  assert.equal(h.calls.filter(call => call[0] === 'editPlaceholder').length, 1, 'pending blocked edit is flushed exactly once');
  const settlements = h.calls.filter(call => call[0] === 'settle');
  assert.equal(settlements.length, 1);
  assert.equal((settlements[0][1] as Record<string, unknown>).recoveryText, RECOVERY_TEXT);
  const record = recordOf(h);
  assert.equal(record.tombstone, true);
  assert.equal(record.pendingEffect, undefined);
});

test('normal flow delivers the recovery hint exactly once total and leaves no marker', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  await h.action(settled());
  assert.equal(h.calls.filter(call => call[0] === 'editPlaceholder').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'sendRecovery').length, 0);
  assert.equal(h.calls.filter(call => call[0] === 'settle').length, 1);
  const record = recordOf(h);
  assert.equal(record.tombstone, true);
  assert.equal(record.pendingEffect, undefined);
});

test('v2 records without the marker (written before this change) still load and answer replay', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  const blockedPost = h.writes[h.writes.length - 1];
  // Strip the field as old records lack it.
  const legacy = { ...(blockedPost.value as Record<string, unknown>) } as Record<string, unknown>;
  delete legacy.pendingEffect;
  const redelivered = h.rewindTo({ key: blockedPost.key, value: legacy });
  const replay = await redelivered(blocked());
  assert.deepEqual(replay, { deliveryId: 'delivery-2' });
  assert.equal(h.calls.filter(call => call[0] === 'sendRecovery').length, 0, 'no marker, no re-execution');
});

test('flush on a new transition clears the marker so a failed pre-write does not re-run the flushed effect', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  const blockedPre = h.writes.find(write => (
    ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown> | undefined)?.state === 'blocked'
  ));
  assert.ok(blockedPre);
  const resumed = h.rewindTo(blockedPre);

  // The settled pre-write keeps failing (the write-ahead write for the new
  // marker is rejected twice per delivery: the pre-write retries once
  // internally), so the Host retries the same settled delivery. The flush
  // clear is what bounds the re-run: without it every retry would flush the
  // blocked effect again.
  let settledPreFailures = 0;
  const originalSet = h.context.storage.set;
  h.context.storage.set = async (key: string, value: unknown) => {
    const record = value as Record<string, unknown>;
    if ((record.pendingEffect as Record<string, unknown> | undefined)?.state === 'settled') {
      settledPreFailures += 1;
      if (settledPreFailures <= 4) throw new Error('settled pre-write failed');
    }
    return originalSet(key, value);
  };

  await assert.rejects(resumed(settled()), /settled pre-write failed/);
  await assert.rejects(resumed(settled()), /settled pre-write failed/);
  await resumed(settled());
  assert.equal(
    h.calls.filter(call => call[0] === 'editPlaceholder').length,
    1,
    'the flushed blocked recovery runs exactly once across the Host retries',
  );
  assert.equal(h.calls.filter(call => call[0] === 'sendRecovery').length, 0);
  const record = recordOf(h);
  assert.equal(record.tombstone, true);
  assert.equal(record.pendingEffect, undefined);
});

test('pre-settle replay with a mismatched state neither re-runs the effect nor clears the marker', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  const blockedPre = h.writes.find(write => (
    ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown> | undefined)?.state === 'blocked'
  ));
  assert.ok(blockedPre);
  const resumed = h.rewindTo(blockedPre);

  // The marker is blocked; a replayed started event has a different state, so
  // it must neither re-run an effect nor clear the marker.
  await resumed(started());
  assert.equal(h.calls.length, 0, 'a state-mismatched replay re-runs nothing');
  assert.deepEqual(recordOf(h).pendingEffect, { v: 1, state: 'blocked', recoveryText: RECOVERY_TEXT });

  // The matching blocked replay re-runs the recovery exactly once and clears.
  await resumed(blocked());
  assert.equal(h.calls.filter(call => call[0] === 'editPlaceholder').length, 1);
  assert.equal(recordOf(h).pendingEffect, undefined);
});

test('zero bindings on the flush path keeps the marker so a later redelivery still recovers the hint', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  const blockedPre = h.writes.find(write => (
    ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown> | undefined)?.state === 'blocked'
  ));
  assert.ok(blockedPre);
  const resumed = h.rewindTo(blockedPre);

  // The thread temporarily has no provider binding: the flush is a no-op and
  // the delivery is rejected. The marker must survive, otherwise the recovery
  // hint would be lost for good once the binding returns.
  h.context.threads.listBindings = async () => [];
  await assert.rejects(resumed(settled()), (error: unknown) => (
    (error as { code?: string }).code === 'PLUGIN_INTERNAL'
    && (error as Error).message.includes('has no provider binding')
  ));
  assert.deepEqual(recordOf(h).pendingEffect, { v: 1, state: 'blocked', recoveryText: RECOVERY_TEXT });
  assert.equal(h.calls.length, 0, 'the flush attempted nothing without a binding');

  // Binding returns; the Host redelivers the same settled event. The blocked
  // recovery runs exactly once and the settle completes.
  h.context.threads.listBindings = async () => [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }];
  await resumed(settled());
  assert.equal(h.calls.filter(call => call[0] === 'editPlaceholder').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'sendRecovery').length, 0);
  assert.equal(h.calls.filter(call => call[0] === 'settle').length, 1);
  assert.equal(recordOf(h).tombstone, true);
  assert.equal(recordOf(h).pendingEffect, undefined);
});

test('zero bindings on the pre-settle replay path keeps the marker so a later redelivery still recovers the hint', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  const blockedPre = h.writes.find(write => (
    ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown> | undefined)?.state === 'blocked'
  ));
  assert.ok(blockedPre);
  const redelivered = h.rewindTo(blockedPre);

  // The thread temporarily has no provider binding during the crash
  // redelivery: the replay is a no-op and must not clear the marker,
  // otherwise the recovery hint would be lost for good once the binding
  // returns.
  h.context.threads.listBindings = async () => [];
  assert.deepEqual(await redelivered(blocked()), { deliveryId: 'delivery-2' });
  assert.deepEqual(recordOf(h).pendingEffect, { v: 1, state: 'blocked', recoveryText: RECOVERY_TEXT });
  assert.equal(h.calls.length, 0, 'the replay attempted nothing without a binding');

  // Binding returns; the Host redelivers the same blocked event. The
  // recovery effect runs exactly once and the marker clears.
  h.context.threads.listBindings = async () => [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }];
  assert.deepEqual(await redelivered(blocked()), { deliveryId: 'delivery-2' });
  assert.equal(h.calls.filter(call => call[0] === 'editPlaceholder').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'sendRecovery').length, 0);
  assert.equal(recordOf(h).pendingEffect, undefined);
});

test('zero bindings on the tombstone replay path keeps the marker so a later redelivery still re-runs settle', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  await h.action(settled());
  const settledPre = h.writes.find(write => (
    ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown> | undefined)?.state === 'settled'
  ));
  assert.ok(settledPre);
  const redelivered = h.rewindTo(settledPre);

  h.context.threads.listBindings = async () => [];
  assert.deepEqual(await redelivered(settled()), { deliveryId: 'delivery-3' });
  assert.deepEqual(recordOf(h).pendingEffect, { v: 1, state: 'settled', recoveryText: RECOVERY_TEXT });
  assert.equal(h.calls.length, 0, 'the replay attempted nothing without a binding');

  h.context.threads.listBindings = async () => [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }];
  assert.deepEqual(await redelivered(settled()), { deliveryId: 'delivery-3' });
  assert.equal(h.calls.filter(call => call[0] === 'settle').length, 1);
  assert.equal(recordOf(h).pendingEffect, undefined);
});

test('a throwing listBindings surfaces as a coded PLUGIN_INTERNAL error, on the normal and the re-execute path', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  const blockedPre = h.writes.find(write => (
    ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown> | undefined)?.state === 'blocked'
  ));
  assert.ok(blockedPre);
  h.context.threads.listBindings = async () => { throw new Error('redis down'); };
  // New-transition path.
  await assert.rejects(h.action(settled()), (error: unknown) => (
    (error as { code?: string }).code === 'PLUGIN_INTERNAL'
    && (error as Error).message.includes('binding listing failed')
  ));
  // Crash-redelivery re-execute path.
  const redelivered = h.rewindTo(blockedPre);
  await assert.rejects(redelivered(blocked()), (error: unknown) => (
    (error as { code?: string }).code === 'PLUGIN_INTERNAL'
    && (error as Error).message.includes('binding listing failed')
  ));
  assert.deepEqual(recordOf(h).pendingEffect, { v: 1, state: 'blocked', recoveryText: RECOVERY_TEXT }, 'a failed re-execute keeps the marker');
});

test('sender name resolves once per started even with several bindings', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  let resolveCalls = 0;
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
      listBindings: async () => [
        { key: 'chat-1', threadId: 'thread-1', createdAt: 1 },
        { key: 'chat-2', threadId: 'thread-1', createdAt: 2 },
      ],
    },
    log() {},
  } as unknown as FeatureContext;
  const sent: unknown[][] = [];
  const action = createConnectorLifecycleAction(context, {
    async sendPlaceholder(...args) { sent.push(args); return `placeholder-${sent.length}`; },
    async editPlaceholder() { return true; },
    async sendRecovery() {},
    async settle() {},
    async resolveReplySenderName() { resolveCalls += 1; return '布偶猫'; },
  });
  await action({ ...started(), replyTo: 'host-message-1' });
  assert.equal(resolveCalls, 1, 'one lookup per started, not one per binding');
  assert.equal(sent.length, 2);
  assert.ok(sent.every(args => (args[1] as string).includes('→布偶猫')));
});

test('a throwing blocked edit during re-execution is logged and falls back to the recovery send without failing the action', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  const blockedPre = h.writes.find(write => (
    ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown> | undefined)?.state === 'blocked'
  ));
  assert.ok(blockedPre);
  h.callbacks.editPlaceholder = async (...args) => { h.calls.push(['editPlaceholder', ...args]); throw new Error('telegram timeout'); };
  const redelivered = h.rewindTo(blockedPre);

  const first = await redelivered(blocked());
  assert.deepEqual(first, { deliveryId: 'delivery-2' }, 'a failed platform effect must not fail the redelivery');
  const warnings = h.logs.filter(log => log[0] === 'warn' && String(log[1]).includes('blocked edit'));
  assert.equal(warnings.length, 1, 'the swallowed edit failure is logged as a warning');
  assert.equal((warnings[0][2] as { lifecycleId?: string }).lifecycleId, 'life-1');
  const recoverySends = h.calls.filter(call => call[0] === 'sendRecovery');
  assert.equal(recoverySends.length, 1, 'the unapplied edit falls back to the recovery send');
  assert.deepEqual(recoverySends[0], ['sendRecovery', 'chat-1', RECOVERY_TEXT]);
  assert.equal(recordOf(h).pendingEffect, undefined, 'the marker is still cleared after the attempt');

  await redelivered(blocked());
  assert.equal(h.calls.filter(call => call[0] === 'sendRecovery').length, 1, 'the cleared marker turns a further redelivery into a plain replay');
});

test('a lost marker-clear write is tolerated: the marker survives and the next redelivery re-executes once more', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  const blockedPre = h.writes.find(write => (
    ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown> | undefined)?.state === 'blocked'
  ));
  assert.ok(blockedPre);
  // Simulate the clear write being lost (e.g. storage hiccup): any write that
  // drops the marker fails, everything else succeeds.
  const originalSet = h.context.storage.set;
  h.context.storage.set = async (key: string, value: unknown) => {
    if ((value as Record<string, unknown>).pendingEffect === undefined) throw new Error('clear write lost');
    return originalSet(key, value);
  };
  const redelivered = h.rewindTo(blockedPre);

  await redelivered(blocked());
  assert.equal(h.calls.filter(call => call[0] === 'editPlaceholder').length, 1);
  assert.ok(recordOf(h).pendingEffect, 'the lost clear leaves the marker in place');
  const clearWarnings = () => h.logs.filter(log => log[0] === 'warn' && String(log[1]).includes('pending-effect clear failed'));
  assert.equal(clearWarnings().length, 1, 'the lost clear is logged, not thrown');

  await redelivered(blocked());
  assert.equal(h.calls.filter(call => call[0] === 'editPlaceholder').length, 2, 'a further redelivery re-executes exactly once more');
  assert.equal(clearWarnings().length, 2, 'each lost clear is logged');
});

test('a lost settle marker-clear write is tolerated: the marker survives and a further redelivery re-runs settle once more', async () => {
  const h = harness();
  await h.action(started());
  await h.action(blocked());
  await h.action(settled());
  const settledPre = h.writes.find(write => (
    ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown> | undefined)?.state === 'settled'
  ));
  assert.ok(settledPre);
  // Simulate the post-settle clear write being lost (e.g. storage hiccup):
  // any write that drops the marker fails, everything else succeeds.
  const originalSet = h.context.storage.set;
  h.context.storage.set = async (key: string, value: unknown) => {
    if ((value as Record<string, unknown>).pendingEffect === undefined) throw new Error('clear write lost');
    return originalSet(key, value);
  };
  const redelivered = h.rewindTo(settledPre);

  await redelivered(settled());
  assert.equal(h.calls.filter(call => call[0] === 'settle').length, 1);
  assert.ok(recordOf(h).pendingEffect, 'the lost clear leaves the settled marker in place');
  const clearWarnings = () => h.logs.filter(log => log[0] === 'warn' && String(log[1]).includes('pending-effect clear failed'));
  assert.equal(clearWarnings().length, 1, 'the lost clear is logged, not thrown');

  await redelivered(settled());
  assert.equal(h.calls.filter(call => call[0] === 'settle').length, 2, 'a further redelivery re-runs settle exactly once more');
  assert.equal(clearWarnings().length, 2, 'each lost clear is logged');

  // Once the clear can land again, one more redelivery re-runs settle a final
  // time and clears the marker; after that, redeliveries answer plain replay.
  h.context.storage.set = originalSet;
  await redelivered(settled());
  assert.equal(h.calls.filter(call => call[0] === 'settle').length, 3, 'the redelivery whose clear lands re-runs settle once more');
  assert.equal(recordOf(h).pendingEffect, undefined);
  await redelivered(settled());
  assert.equal(h.calls.filter(call => call[0] === 'settle').length, 3, 'no effect once the marker is cleared');
});

test('re-execution covers every binding of the thread, not just the first', async () => {
  const state = new Map<string, { revision: number; value: unknown }>();
  const writes: Array<{ key: string; value: unknown }> = [];
  const calls: unknown[][] = [];
  const context = {
    storage: {
      get: async (key: string) => state.get(key),
      set: async (key: string, value: unknown) => {
        writes.push({ key, value: structuredClone(value) });
        const revision = (state.get(key)?.revision ?? 0) + 1;
        state.set(key, { revision, value });
        return { revision };
      },
    },
    threads: {
      listBindings: async () => [
        { key: 'chat-1', threadId: 'thread-1', createdAt: 1 },
        { key: 'chat-2', threadId: 'thread-1', createdAt: 2 },
      ],
    },
    log() {},
  } as unknown as FeatureContext;
  const callbacks: ConnectorLifecycleCallbacks = {
    async sendPlaceholder(...args) { calls.push(['sendPlaceholder', ...args]); return `placeholder-${calls.length}`; },
    async editPlaceholder(...args) { calls.push(['editPlaceholder', ...args]); return true; },
    async sendRecovery(...args) { calls.push(['sendRecovery', ...args]); },
    async settle(input) { calls.push(['settle', input]); },
  };
  const action = createConnectorLifecycleAction(context, callbacks);
  await action(started());
  await action(blocked());
  const blockedPre = writes.find(write => (
    ((write.value as Record<string, unknown>).pendingEffect as Record<string, unknown> | undefined)?.state === 'blocked'
  ));
  assert.ok(blockedPre);
  assert.deepEqual(Object.keys((blockedPre.value as Record<string, unknown>).platformMessageByKey as object).sort(), ['chat-1', 'chat-2']);
  // Rewind to the blocked pre-write and redeliver with a fresh action, as the
  // Host does after a crash.
  const revision = (state.get(blockedPre.key)?.revision ?? 0) + 1;
  state.set(blockedPre.key, { revision, value: structuredClone(blockedPre.value) });
  calls.length = 0;
  const redelivered = createConnectorLifecycleAction(context, callbacks);

  await redelivered(blocked());
  const edits = calls.filter(call => call[0] === 'editPlaceholder');
  assert.deepEqual(edits.map(call => call[1]).sort(), ['chat-1', 'chat-2'], 'both bindings receive the re-executed edit');
  assert.ok(edits.every(call => call[3] === RECOVERY_TEXT));
  assert.equal(calls.filter(call => call[0] === 'sendRecovery').length, 0, 'applied edits do not fall back to a recovery send');

  await redelivered(blocked());
  assert.equal(calls.filter(call => call[0] === 'editPlaceholder').length, 2, 'a further redelivery does not duplicate the edits');
});

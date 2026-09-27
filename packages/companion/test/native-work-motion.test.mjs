import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeNativeWork } from '../src/native-work-motion.mjs';

const event = (overrides = {}) => ({
  eventId: 'scope:1', taskId: 'scope/turn', kind: 'tool', phase: 'completed',
  occurredAt: 100, expiresAt: 10_000, ...overrides,
});

test('active Host work chooses a stable semantic priority without inventing movement', () => {
  const snapshot = normalizeNativeWork({ scopeId: '0123456789abcdef', revision: 4, active: [
    { taskId: 'reasoning', nativeTurnId: 'turn', kind: 'reasoning', startedAt: 10, expiresAt: 10_000 },
    { taskId: 'tool', nativeTurnId: 'turn', kind: 'tool', startedAt: 20, expiresAt: 10_000 },
    { taskId: 'screen', nativeTurnId: 'turn', kind: 'screen_read', startedAt: 30, expiresAt: 10_000 },
  ], recent: [] }, 1_000);
  assert.deepEqual(snapshot, {
    work: { taskId: 'screen', kind: 'screen_reading', status: 'active', expiresAt: 10_000 },
    delivery: null,
    travel: null,
  });
});

test('workspace completion is work history, while only a handed result can deliver once', () => {
  const nativeWork = { scopeId: '0123456789abcdef', revision: 5, active: [], recent: [
    event({ eventId: 'scope:1', kind: 'workspace_dispatch', phase: 'completed' }),
    event({ eventId: 'scope:2', taskId: 'scope/turn', kind: 'result', phase: 'result_handed_to_voice',
      resultId: 'result-1', nativeCarrierCatId: 'codex-sol' }),
  ] };
  assert.deepEqual(normalizeNativeWork(nativeWork, 1_000)?.delivery,
    { resultId: 'result-1', status: 'applied', expiresAt: 10_000 });
  assert.equal(normalizeNativeWork(nativeWork, 10_000)?.delivery, null, 'expired handoffs cannot queue');
});

test('idle and cancelled snapshots clear every transient source', () => {
  assert.deepEqual(normalizeNativeWork({ scopeId: null, revision: 0, active: [], recent: [] }, 1_000),
    { work: null, delivery: null, travel: null });
  assert.equal(normalizeNativeWork(undefined, 1_000), null, 'legacy absence stays distinguishable from idle truth');
});

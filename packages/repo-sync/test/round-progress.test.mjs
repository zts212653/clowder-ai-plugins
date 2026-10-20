import assert from 'node:assert/strict';
import test from 'node:test';
import { roundProgress } from '../src/round-progress.mjs';
import { roundView } from '../web/round-view.mjs';

const start = '2026-10-17T00:00:00Z';
const item = (target, status, id = target) => ({
  id,
  target,
  status,
  startedAt: start,
  source: { kind: 'pr', number: 12, title: 'Upstream source', url: 'https://github.com/demo/core/pull/12' },
  issues: [],
});
const run = {
  id: 'run',
  startedAt: start,
  startingDeliveryId: null,
  startingDeliveryCount: 1,
  scanned: true,
  selection: { kind: 'commit', value: 'target' },
  target: 'target',
};
test('round progress survives compact status and counts acceptance rather than PR creation', () => {
  const state = {
    automation: run,
    activeId: 'B',
    deliveries: [item('old', 'COMPLETE'), item('A', 'COMPLETE'), item('B', 'CODE_ACCEPTED_PENDING_METADATA')],
    queue: [item('B'), item('C')],
  };
  const r = roundProgress(state);
  assert.deepEqual(r.counts, { complete: 1, current: 1, pending: 1, cancelled: 0 });
  assert.equal(r.total, 3);
  assert.deepEqual(
    r.items.map((i) => i.target),
    ['A', 'B', 'C'],
  );
  assert.equal(r.current.target, 'B');
  state.deliveries[2].status = 'COMPLETE';
  state.queue.shift();
  assert.equal(
    roundProgress(state).counts.complete,
    2,
    'stale activeId must not reclassify an accepted delivery',
  );
  assert.match(roundView(r), /1 \/ 3/);
  assert.match(roundView(r), /上游 PR #12/);
});
test('retry targets do not duplicate totals, cancelled attempts remain traceable', () => {
  const state = {
    automation: { ...run, startingDeliveryCount: 0 },
    activeId: 'retry',
    deliveries: [item('A', 'CANCELLED', 'first'), item('A', 'WAITING_APPROVAL', 'retry')],
    queue: [item('A'), item('B')],
  };
  const r = roundProgress(state);
  assert.equal(r.total, 2);
  assert.equal(r.current.deliveryId, 'retry');
  state.deliveries.pop();
  state.activeId = null;
  const retry = roundProgress(state).items[0];
  assert.equal(retry.status, 'pending');
  assert.equal(retry.lastAttempt, 'first');
});
test('round filters and bounded pagination cover large queues without using the history page', () => {
  const state = {
    automation: { ...run, startingDeliveryCount: 0 },
    deliveries: [],
    queue: Array.from({ length: 61 }, (_, i) => item(String(i))),
  };
  const r = roundProgress(state, new URLSearchParams('status=pending&offset=40&limit=20'));
  assert.equal(r.matched, 61);
  assert.equal(r.items.length, 20);
  assert.equal(r.items[0].target, '40');
  for (const q of ['limit=51', 'offset=-1', 'status=bogus', 'status=all&status=current', 'project=other'])
    assert.throws(() => roundProgress(state, new URLSearchParams(q)), { code: 'INVALID_ROUND_QUERY' });
});
test('legacy admission includes a taken-over delivery, and unfrozen scans never invent a total', () => {
  const state = {
    automation: { ...run, startingDeliveryCount: undefined, startingDeliveryId: 'prior', scanned: false },
    deliveries: [{ ...item('A', 'COMPLETE', 'prior'), startedAt: '2026-01-01T00:00:00Z' }],
    queue: [],
  };
  const r = roundProgress(state);
  assert.equal(r.counts.complete, 1);
  assert.equal(r.total, null);
});

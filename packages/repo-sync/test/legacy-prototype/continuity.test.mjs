import assert from 'node:assert/strict';
import test from 'node:test';
import { renderOverview } from './render-overview.mjs';
import { createState, reduce } from './state.mjs';

function receive(state) {
  state = reduce(state, { type: 'start' });
  for (let i = 0; i < 5; i++) state = reduce(state, { type: 'advance' });
  return reduce(reduce(reduce(state, { type: 'approve' }), { type: 'advance' }), { type: 'advance' });
}
test('a shared Issue stays open after U1, but U1 completes and U2 can start', () => {
  let state = receive(createState('shared-issue'));
  assert.equal(state.active.phase, 9);
  assert.equal(state.active.issueStatus, 'open');
  assert.equal(state.active.issueResult, 'waiting-deliveries');
  assert.deepEqual(state.active.issuePendingDeliveries, ['delivery-042']);
  assert.match(renderOverview(state, 9), /等待后续交付/);
  state = receive(state);
  assert.equal(state.active.phase, 9);
  assert.equal(state.active.internalIssue, 318);
  assert.equal(state.active.issueStatus, 'closed');
  assert.deepEqual(state.active.issuePendingDeliveries, []);
});
test('a merged delivery without a saved cursor restores the original delivery first', () => {
  const interrupted = createState('merge-interrupted');
  assert.notEqual(interrupted.accepted, interrupted.active.target);
  assert.equal(interrupted.active.block, 'recovery');
  assert.match(renderOverview(interrupted, 7), /核对合入结果并恢复/);
  assert.equal(reduce(interrupted, { type: 'start' }).active.id, interrupted.active.id);
  const recovered = reduce(interrupted, { type: 'recover' });
  assert.equal(recovered.active.phase, 8);
  assert.equal(recovered.accepted, interrupted.active.target);
  assert.equal(recovered.internalSha, interrupted.internalSha);
  assert.equal(recovered.active.internalPr, interrupted.active.internalPr);
  assert.equal(recovered.active.internalIssue, interrupted.active.internalIssue);
});
test('an ambiguous merge result pauses without advancing the acceptance cursor', () => {
  const interrupted = createState('merge-interrupted');
  interrupted.active.mergeEvidence.verified = false;
  const recovered = reduce(interrupted, { type: 'recover' });
  assert.equal(recovered.accepted, interrupted.accepted);
  assert.equal(recovered.active.block, 'recovery');
  assert.equal(recovered.active.error.code, 'MERGE_RESULT_CONFLICT');
});

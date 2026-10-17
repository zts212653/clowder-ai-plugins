import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeReadiness, mergeWait, validateMergeObservation } from '../src/merge-readiness.mjs';
import { stagePresentation } from '../web/flow-stage.mjs';

const head = 'a'.repeat(40);
const ready = {
  merge_status: 'can_be_merged',
  head_pipeline: { id: 1, sha: head, status: 'success' },
};
test('merge readiness distinguishes current CI, transient checks, human waits and terminal failure', () => {
  assert.equal(mergeReadiness(ready, head).kind, 'ready');
  for (const status of ['created', 'pending', 'running', 'preparing', 'waiting_for_resource'])
    assert.equal(mergeReadiness({ ...ready, head_pipeline: { sha: head, status } }, head).kind, 'wait');
  for (const detailed_merge_status of ['checking', 'ci_still_running', 'approvals_syncing'])
    assert.equal(mergeReadiness({ ...ready, detailed_merge_status }, head).kind, 'wait');
  assert.equal(mergeReadiness({ ...ready, detailed_merge_status: 'not_approved' }, head).manual, true);
  assert.equal(mergeReadiness({ ...ready, draft: true }, head).manual, true);
  assert.equal(mergeReadiness({ ...ready, has_conflicts: true }, head).kind, 'blocked');
  for (const status of ['failed', 'canceled'])
    assert.equal(mergeReadiness({ ...ready, head_pipeline: { sha: head, status } }, head).kind, 'blocked');
});
test('CodeHub unchecked with successful current CI may request a SHA-protected platform merge', () => {
  for (const detailed_merge_status of [undefined, '', 'unchecked'])
    assert.equal(mergeReadiness({ ...ready, merge_status: 'unchecked', detailed_merge_status }, head).kind, 'ready');
  for (const patch of [{ draft: true }, { has_conflicts: true }, { detailed_merge_status: 'not_approved' },
    { blocking_discussions_resolved: false }, { approvals_left: 1 }])
    assert.notEqual(mergeReadiness({ ...ready, merge_status: 'unchecked', ...patch }, head).kind, 'ready');
  for (const head_pipeline of [undefined, { status: 'success', sha: 'b'.repeat(40) }, { status: 'pending', sha: head }])
    assert.notEqual(mergeReadiness({ merge_status: 'unchecked', head_pipeline }, head).kind, 'ready');
});
test('missing, skipped or stale CI never authorizes a merge of an unproven candidate', () => {
  for (const head_pipeline of [
    null,
    {},
    { status: 'skipped', sha: head },
    { status: 'success' },
    { status: 'success', sha: 'b'.repeat(40) },
  ])
    assert.equal(mergeReadiness({ merge_status: 'can_be_merged', head_pipeline }, head).kind, 'wait');
});
test('wait observations preserve deadlines through reload and cap the next poll interval', () => {
  const d = { candidate: head },
    now = Date.now();
  for (let i = 0; i < 9; i++) {
    d.autoMerge = mergeWait(d, { kind: 'wait', reason: 'CI pending' }, now + i * 10000);
    assert.equal(Date.parse(d.autoMerge.deadlineAt), now + 1800000);
    assert.ok(Date.parse(d.autoMerge.nextCheckAt) - (now + i * 10000) <= 30000);
  }
  validateMergeObservation(d, () => assert.fail());
  assert.equal(d.autoMerge.pollCount, 9);
});
test('imported merge observations reject changed identity, unknown fields and corrupt times', () => {
  const valid = mergeWait({ candidate: head }, { kind: 'wait', reason: 'CI pending' }, Date.now());
  const fail = (code) => {
    throw Object.assign(Error(code), { code });
  };
  for (const value of [
    { ...valid, token: 'forbidden' },
    { ...valid, head: 'b'.repeat(40) },
    { ...valid, nextCheckAt: 'invalid' },
    { ...valid, pollCount: -1 },
    { ...valid, manual: 'yes' },
  ])
    assert.throws(() => validateMergeObservation({ candidate: head, autoMerge: value }, fail), {
      code: 'LEDGER_INVALID',
    });
  assert.equal(
    mergeReadiness({ ...ready, head_pipeline: { sha: 'b'.repeat(40), status: 'failed' } }, head).kind,
    'wait',
  );
});
test('merge projections honor opt-out and complete platform observation before acceptance', () => {
  const d = {
    prUrl: 'https://example/core/pull/1',
    autoMerge: { status: 'WAITING' },
  };
  assert.equal(stagePresentation(4, d, 4, 0, { autoMerge: true }).state, 'waiting-system');
  assert.equal(stagePresentation(4, d, 4, 0, { autoMerge: false }).state, 'waiting-human');
  d.autoMerge.requestedAt = new Date().toISOString();
  assert.equal(stagePresentation(4, d, 4, 0, { autoMerge: false }).state, 'waiting-system');
  d.mergeObservation = { source: 'platform' };
  assert.equal(stagePresentation(4, d, 4).state, 'done');
});

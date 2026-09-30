import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decisionBadge, decisionRows } from '../src/decision-view.mjs';

test('successful legacy reads show pending truth without inventing a precise badge total or a failure', () => {
  const page = { status: 'available', approvalCount: 2, needsMeCount: 3, otherNeedsMeCount: 1,
    approvals: [
      { sourceFeatureId: 'F221', summary: '品味提案', resolution: 'open', materializationState: 'not_started', linkedNeedsMe: true },
      { sourceFeatureId: 'F128', summary: '新线程', resolution: 'accepted', materializationState: 'outcome_unknown', linkedNeedsMe: false },
    ], otherNeedsMe: [{ subjectRef: 'task:one', summary: '看看任务' }] };
  assert.deepEqual(decisionBadge(page), { visible: true, label: '有待办', title: '有待办', state: 'available' });
  assert.equal(decisionRows(page).length, 3);
  assert.match(decisionRows(page)[1].meta, /结果未知/);
  assert.doesNotMatch(decisionRows(page)[0].meta, /F221/u);
});

test('unavailable sources never become a zero badge', () => {
  assert.equal(decisionBadge(undefined).label, '?');
  assert.equal(decisionBadge({ status: 'unavailable' }).visible, true);
  assert.deepEqual(decisionRows({ status: 'unavailable' }), []);
  assert.deepEqual(decisionBadge({ status: 'available', approvalCount: 0, needsMeCount: 0,
    otherNeedsMeCount: 0, approvals: [], otherNeedsMe: [] }), {
    visible: false, label: '0', title: '现在没有待办', state: 'empty',
  });
});

test('a real F221 proposal id remains inspectable while unsafe ids cannot be previewed', () => {
  const page = {
    status: 'available',
    approvals: [
      { proposalId: 'proposal_mgf2abc12345678', sourceFeatureId: 'F221', summary: '品味提案', resolution: 'open', materializationState: 'not_started' },
      { proposalId: '../other-owner', sourceFeatureId: 'F221', summary: '不可信提案', resolution: 'open', materializationState: 'not_started' },
    ],
    otherNeedsMe: [],
  };
  assert.equal(decisionRows(page)[0].previewable, true);
  assert.equal(decisionRows(page)[1].previewable, false);
});

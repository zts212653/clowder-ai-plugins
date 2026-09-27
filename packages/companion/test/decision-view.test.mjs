import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decisionBadge, decisionRows } from '../src/decision-view.mjs';

test('a linked F310 receipt enriches an F246 approval without doubling the badge count', () => {
  const page = { status: 'available', approvalCount: 2, needsMeCount: 3, otherNeedsMeCount: 1,
    approvals: [
      { sourceFeatureId: 'F221', summary: '品味提案', resolution: 'open', materializationState: 'not_started', linkedNeedsMe: true },
      { sourceFeatureId: 'F128', summary: '新线程', resolution: 'accepted', materializationState: 'outcome_unknown', linkedNeedsMe: false },
    ], otherNeedsMe: [{ subjectRef: 'task:one', summary: '看看任务' }] };
  assert.deepEqual(decisionBadge(page), { visible: true, label: '3', title: '2 项审批事项，1 项其他待处理' });
  assert.equal(decisionRows(page).length, 3);
  assert.match(decisionRows(page)[1].meta, /结果未知/);
});

test('unavailable sources never become a zero badge', () => {
  assert.equal(decisionBadge(undefined).label, '?');
  assert.equal(decisionBadge({ status: 'unavailable' }).visible, true);
  assert.deepEqual(decisionRows({ status: 'unavailable' }), []);
  assert.equal(decisionBadge({ status: 'available', approvalCount: 0, otherNeedsMeCount: 0 }).visible, false);
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

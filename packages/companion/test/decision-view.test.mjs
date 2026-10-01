import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decisionBadge, decisionPresentation, decisionRows } from '../src/decision-view.mjs';

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

test('unified reads show only trusted totals and keep every concrete source variant', () => {
  const partial = {
    version: 1, status: 'partial', observedAt: 42,
    sources: {
      approvals: { status: 'available', coverage: 'complete' },
      needsMe: { status: 'unavailable', coverage: 'unknown' },
    },
    items: [
      { variantRef: 'variant-a', kind: 'repair', summary: '修复第一处',
        navigation: { targets: ['action', 'origin'] } },
      { variantRef: 'variant-b', kind: 'repair', summary: '修复冲突版本',
        navigation: { targets: ['origin'] } },
    ],
    page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
  };
  assert.deepEqual(decisionBadge(partial), {
    visible: true, label: '•', title: '仅部分读取', state: 'partial',
  });
  const rows = decisionRows(partial);
  assert.deepEqual(rows.map(row => row.variantRef), ['variant-a', 'variant-b']);
  assert.deepEqual(rows.map(row => row.navigation), [
    { variantRef: 'variant-a', target: 'action', label: '打开处理入口' },
    { variantRef: 'variant-b', target: 'origin', label: '打开原处' },
  ]);

  assert.deepEqual(decisionBadge({ ...partial, status: 'available', totalCount: 2,
    sources: { approvals: { status: 'available', coverage: 'complete' }, needsMe: { status: 'available', coverage: 'complete' } } }), {
    visible: true, label: '2', title: '待办 · 2 件', state: 'available',
  });
  assert.deepEqual(decisionBadge({ ...partial, status: 'available', totalCount: 0, items: [],
    sources: { approvals: { status: 'available', coverage: 'complete' }, needsMe: { status: 'available', coverage: 'complete' } } }), {
    visible: false, label: '0', title: '暂无待办', state: 'empty',
  });
  assert.deepEqual(decisionBadge({ ...partial, status: 'partial', items: [] }), {
    visible: true, label: '!', title: '仅部分读取', state: 'partial',
  }, 'a partial empty known window is not an empty inbox');

  const uncertain = { ...partial, status: 'available', items: [],
    sources: { approvals: { status: 'available', coverage: 'complete' }, needsMe: { status: 'available', coverage: 'complete' } } };
  assert.deepEqual(decisionBadge(uncertain), {
    visible: true, label: '!', title: '数量未确认', state: 'uncertain',
  }, 'complete source reads without verified reconciliation cannot claim zero');
  assert.equal(decisionPresentation(uncertain).pending, null);

  const login = { ...partial, status: 'unavailable', items: [], sources: {
    approvals: { status: 'unauthenticated', coverage: 'unknown' },
    needsMe: { status: 'unauthenticated', coverage: 'unknown' },
  } };
  assert.deepEqual(decisionBadge(login), {
    visible: true, label: '!', title: '需要登录', state: 'authentication',
  });
  assert.match(decisionPresentation(login).message, /需要登录/u);
  assert.deepEqual(decisionRows(login), []);
});

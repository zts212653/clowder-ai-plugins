/** F246 remains the decision truth; linked F310 receipts are enrichment, not another item. */
export function decisionBadge(page) {
  if (!page || page.status !== 'available')
    return { visible: true, label: '?', title: '待办暂不可读', state: 'unavailable' };
  const hasKnownRows = (page.approvals?.length ?? 0) > 0 || (page.otherNeedsMe?.length ?? 0) > 0
    || page.approvalCount > 0 || page.needsMeCount > 0 || page.otherNeedsMeCount > 0;
  if (hasKnownRows) return { visible: true, label: '有待办', title: '有待办', state: 'available' };
  return { visible: false, label: '0', title: '现在没有待办', state: 'empty' };
}

export function decisionRows(page) {
  if (!page || page.status !== 'available') return [];
  const state = {
    open: '待你决定', accepted: '已接纳 · 待核结果', rejected: '已拒绝',
    closed_without_decision: '已关闭',
  };
  return [
    ...page.approvals.map(item => ({
      title: item.summary || '待决策事项',
      meta: `审批 · ${state[item.resolution] ?? '状态待核'} · ${item.materializationState === 'outcome_unknown' ? '结果未知' : item.materializationState === 'failed' ? '执行失败' : item.linkedNeedsMe ? '已关联待办' : '原处卡片'}`,
      proposalId: item.proposalId,
      previewable: item.sourceFeatureId === 'F221' &&
        /^[A-Za-z0-9_-]{1,200}$/.test(item.proposalId) &&
        item.resolution === 'open' && item.materializationState === 'not_started',
    })),
    ...page.otherNeedsMe.map(item => ({ title: item.summary || '待处理事项', meta: '其他待处理 · 请向猫猫询问详情' })),
  ];
}

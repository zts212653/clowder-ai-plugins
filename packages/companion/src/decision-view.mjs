/** F246 remains the decision truth; linked F310 receipts are enrichment, not another item. */
export function decisionBadge(page) {
  if (!page || page.status !== 'available')
    return { visible: true, label: '?', title: '待决事项暂不可读' };
  const total = page.approvalCount + page.otherNeedsMeCount;
  return {
    visible: total > 0,
    label: total > 99 ? '99+' : String(total),
    title: `${page.approvalCount} 项审批事项，${page.otherNeedsMeCount} 项其他待处理`,
  };
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
      meta: `${item.sourceFeatureId} · ${state[item.resolution] ?? '状态待核'} · ${item.materializationState === 'outcome_unknown' ? '结果未知' : item.materializationState === 'failed' ? '执行失败' : item.linkedNeedsMe ? '已关联任务' : '原处卡片'}`,
      proposalId: item.proposalId,
      previewable: item.sourceFeatureId === 'F221' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.proposalId) &&
        item.resolution === 'open' && item.materializationState === 'not_started',
    })),
    ...page.otherNeedsMe.map(item => ({ title: item.summary || '待处理事项', meta: '其他待处理 · 请向猫猫询问详情' })),
  ];
}

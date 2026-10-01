function unified(page) {
  return page?.version === 1 && Array.isArray(page.items);
}

function knownRows(page) {
  if (unified(page)) return page.items.length;
  return (page?.approvals?.length ?? 0) + (page?.otherNeedsMe?.length ?? 0);
}

function authenticationRequired(page) {
  if (!unified(page)) return false;
  const sources = Object.values(page.sources ?? {});
  return sources.length > 0 && sources.every(source => source.status === 'unauthenticated');
}

/** Exact totals exist only on a complete, consistent unified read. Legacy pages never invent a sum. */
export function decisionBadge(page) {
  if (!page) return { visible: true, label: '?', title: '待办暂不可读', state: 'unavailable' };
  if (unified(page)) {
    if (page.status === 'partial') {
      return { visible: true, label: page.items.length > 0 ? '•' : '!', title: '仅部分读取', state: 'partial' };
    }
    if (page.status === 'unavailable') {
      return authenticationRequired(page)
        ? { visible: true, label: '!', title: '需要登录', state: 'authentication' }
        : { visible: true, label: '!', title: '待办暂不可读', state: 'unavailable' };
    }
    if (Number.isInteger(page.totalCount)) {
      return page.totalCount === 0
        ? { visible: false, label: '0', title: '暂无待办', state: 'empty' }
        : { visible: true, label: String(page.totalCount), title: `待办 · ${page.totalCount} 件`, state: 'available' };
    }
    return { visible: true, label: page.items.length > 0 ? '•' : '!', title: '数量未确认', state: 'uncertain' };
  }
  if (page.status !== 'available')
    return { visible: true, label: '?', title: '待办暂不可读', state: 'unavailable' };
  const hasKnownRows = knownRows(page) > 0
    || page.approvalCount > 0 || page.needsMeCount > 0 || page.otherNeedsMeCount > 0;
  if (hasKnownRows) return { visible: true, label: '有待办', title: '有待办', state: 'available' };
  return { visible: false, label: '0', title: '现在没有待办', state: 'empty' };
}

function approvalMeta(approval) {
  const state = {
    open: '待你决定', accepted: '已接纳 · 待核结果', rejected: '已拒绝',
    closed_without_decision: '已关闭',
  };
  const materialization = approval.materializationState === 'outcome_unknown' ? '结果未知'
    : approval.materializationState === 'failed' ? '执行失败'
      : approval.linkedNeedsMe ? '已关联待办' : '原处卡片';
  return `审批 · ${state[approval.resolution] ?? '状态待核'} · ${materialization}`;
}

function navigation(item) {
  const priorities = item.kind === 'approval'
    ? [['approval_card', '打开审批'], ['action', '打开处理入口'], ['origin', '打开原处']]
    : [['action', '打开处理入口'], ['origin', '打开原处'], ['approval_card', '打开审批']];
  const selected = priorities.find(([target]) => item.navigation.targets.includes(target));
  return selected ? { variantRef: item.variantRef, target: selected[0], label: selected[1] } : undefined;
}

export function decisionRows(page) {
  if (unified(page)) {
    if (page.status === 'unavailable') return [];
    return page.items.map(item => ({
      title: item.summary || '待处理事项',
      meta: item.kind === 'approval' ? approvalMeta(item.approval)
        : item.kind === 'judgment' ? '等你判断 · 请在原处处理' : '需要修复 · 请在原处处理',
      variantRef: item.variantRef,
      navigation: navigation(item),
      previewable: false,
    }));
  }
  if (!page || page.status !== 'available') return [];
  return [
    ...(page.approvals ?? []).map(item => ({
      title: item.summary || '待决策事项',
      meta: approvalMeta(item),
      proposalId: item.proposalId,
      previewable: item.sourceFeatureId === 'F221'
        && /^[A-Za-z0-9_-]{1,200}$/.test(item.proposalId)
        && item.resolution === 'open' && item.materializationState === 'not_started',
    })),
    ...(page.otherNeedsMe ?? []).map(item => ({ title: item.summary || '待处理事项', meta: '其他待处理 · 请向猫猫询问详情' })),
  ];
}

export function decisionPresentation(page) {
  const badge = decisionBadge(page);
  if (!page) return { badge, message: '待办暂不可读 · 请稍后刷新', reloadLabel: '重试', pending: null, hasMore: false, renderRows: false };
  if (unified(page)) {
    const pending = Number.isInteger(page.totalCount) ? page.totalCount > 0 : page.items.length > 0 ? true : null;
    if (page.status === 'partial') return {
      badge, message: '仅部分读取 · 其余待办未能读取', reloadLabel: '重试', pending,
      hasMore: page.page.hasMore, renderRows: true,
    };
    if (page.status === 'unavailable') return {
      badge, message: authenticationRequired(page) ? '待办需要登录 · 请登录后重试' : '待办暂不可读 · 请稍后重试',
      reloadLabel: '重试', pending: null, hasMore: false, renderRows: false,
    };
    if (page.totalCount === 0) return {
      badge, message: '暂无待办', reloadLabel: '刷新', pending: false,
      hasMore: page.page.hasMore, renderRows: true,
    };
    return {
      badge,
      message: Number.isInteger(page.totalCount)
        ? `已读取 ${page.totalCount} 件待办`
        : '已显示读取到的待办 · 数量未确认',
      reloadLabel: '刷新', pending,
      hasMore: page.page.hasMore, renderRows: true,
    };
  }
  if (page.status !== 'available') return {
    badge, message: '待办暂不可读 · 请稍后刷新', reloadLabel: '重试', pending: null, hasMore: false, renderRows: false,
  };
  return {
    badge,
    message: badge.state === 'empty' ? '现在没有待你处理的事项' : '已显示读取到的待办 · 暂无总数',
    reloadLabel: '刷新', pending: badge.state === 'empty' ? false : true,
    hasMore: page.page.hasMoreApprovals || page.page.hasMoreNeedsMe,
    renderRows: true,
  };
}

export function issueRelation(delivery) {
  return delivery.issueRelation === 'related' ? 'related' : 'closes';
}
export function issueStatus(delivery, phase) {
  if (delivery.issueStatus) return delivery.issueStatus;
  if (delivery.block === 'metadata') return 'open';
  return phase >= 7 && issueRelation(delivery) === 'closes' && delivery.autoCloseIssue !== false ? 'closed' : 'open';
}
export function platformIssueStatus(delivery) {
  if (delivery.issueStatus === 'closed') return 'closed';
  if (delivery.requiredDeliveries?.length > 1) return 'open';
  return issueRelation(delivery) === 'closes' && delivery.autoCloseIssue !== false ? 'closed' : 'open';
}
export function reconcileIssue(state) {
  const active = state.active;
  const original = state.deliveries.find((item) => item.id === active.id);
  if (
    !original ||
    !active.internalIssue ||
    active.internalIssue !== original.internalIssue ||
    active.issue !== original.issue ||
    state.accepted !== active.target
  ) {
    active.block = 'metadata';
    active.error = { code: 'ISSUE_MAPPING_UNVERIFIED', message: '内部 Issue 映射或代码核验记录不完整，暂停关单。' };
    return false;
  }
  active.issueStatus = issueStatus(active, 8);
  const received = state.deliveries.filter((item) => item.metadataComplete).map((item) => item.id);
  active.issuePendingDeliveries = (active.requiredDeliveries ?? [active.id]).filter(
    (id) => id !== active.id && !received.includes(id),
  );
  if (issueRelation(active) === 'related') active.issueResult = 'left-unchanged';
  else if (active.issuePendingDeliveries.length) {
    active.issueStatus = 'open';
    active.issueResult = 'waiting-deliveries';
  } else if (active.issueStatus === 'closed') active.issueResult = 'already-closed';
  else {
    active.issueStatus = 'closed';
    active.issueResult = 'closed-by-sync';
  }
  Object.assign(original, {
    issueRelation: issueRelation(active),
    issueStatus: active.issueStatus,
    issueResult: active.issueResult,
    issuePendingDeliveries: active.issuePendingDeliveries,
    metadataComplete: true,
  });
  return true;
}
export function issueAuditMessage(delivery) {
  const actions = {
    'already-closed': '平台已关闭，仅确认关单结果',
    'closed-by-sync': '同步程序补充关闭内部 Issue（模拟）',
    'left-unchanged': '普通关联，保留内部 Issue 现有状态',
    'waiting-deliveries': `本笔接收记录已保存，Issue 保持打开；等待后续交付 ${(delivery.issuePendingDeliveries ?? []).join(' / ')}`,
  };
  return `外部 #${delivery.issue} → 内部 #${delivery.internalIssue}；${actions[delivery.issueResult]}；对象复用，交付完成`;
}
export function issueSummary(delivery, phase) {
  if (delivery.error?.code === 'ISSUE_MAPPING_UNVERIFIED') return '映射或核验记录待核对，关单已暂停；保留现有状态';
  const number = delivery.internalIssue ? `内部 #${delivery.internalIssue}` : '内部 Issue';
  const status = issueStatus(delivery, phase) === 'closed' ? '已关闭' : '打开';
  if (phase < 3) return '准备阶段创建 / 复用并建立映射';
  if (delivery.issuePendingDeliveries?.length)
    return `本笔已接收，${number} 保持打开；等待后续交付 ${delivery.issuePendingDeliveries.join(' / ')}`;
  if (issueRelation(delivery) === 'related') return `普通关联 · ${number} ${status}；保留现有状态`;
  if (phase < 7) return `${number} 已创建并映射；等待 PR 合入后更新接收状态`;
  if (delivery.issueResult === 'closed-by-sync') return `${number} 已由同步程序补充关闭`;
  if (phase >= 9) return `${number} 已关闭；确认平台关单结果`;
  return issueStatus(delivery, phase) === 'closed'
    ? `${number} 平台已关闭，等待确认结果`
    : `${number} 仍打开，待补充关闭`;
}

export function seedContinuity(state, scenario) {
  if (scenario === 'shared-issue') {
    for (const delivery of state.deliveries) {
      delivery.issue = 71;
      delivery.internalIssue = 318;
      delivery.requiredDeliveries = ['delivery-041', 'delivery-042'];
      delivery.autoCloseIssue = false;
    }
  }
  if (!['merge-interrupted', 'merge-conflict'].includes(scenario)) return;
  state.internalSha = '11c79a50';
  state.active = {
    ...structuredClone(state.deliveries[0]),
    bindingId: state.binding.id,
    phase: 7,
    block: 'recovery',
    issueStatus: 'open',
    mergeEvidence: { verified: scenario !== 'merge-conflict', internalSha: state.internalSha },
  };
}
export function restoreAcceptance(state) {
  const active = state.active;
  if (!active.mergeEvidence?.verified || active.mergeEvidence.internalSha !== state.internalSha) {
    active.error = {
      code: 'MERGE_RESULT_CONFLICT',
      message: '实际合入结果无法唯一归属于冻结交付，保持原游标并暂停。',
    };
    return false;
  }
  state.accepted = active.target;
  active.phase = 8;
  active.block = null;
  delete active.error;
  return true;
}
export function resumeContinuity(state, log) {
  if (state.active.block !== 'recovery') return false;
  const restored = restoreAcceptance(state);
  log(
    state,
    restored ? '已核对原交付合入结果，补写接受版本' : '合入结果冲突，恢复暂停',
    restored
      ? `${state.active.target} ↔ ${state.internalSha}；复用原 Issue/PR，继续元数据`
      : state.active.error.message,
  );
  return true;
}

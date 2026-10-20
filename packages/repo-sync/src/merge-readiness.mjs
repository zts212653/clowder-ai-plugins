const activeCI = new Set(['created', 'pending', 'running', 'preparing', 'waiting_for_resource', 'scheduled']);
const human = new Set(['not_approved', 'discussions_not_resolved', 'draft_status', 'requested_changes']);
const checking = new Set(['checking', 'approvals_syncing', 'ci_still_running', 'ci_must_pass']);
export function mergeReadiness(detail, head) {
  const status = detail.detailed_merge_status || detail.merge_status;
  const pipeline = detail.head_pipeline ?? detail.pipeline;
  const wait = (reason, manual = false) => ({ kind: 'wait', reason, manual });
  if (detail.has_conflicts === true || ['conflict', 'cannot_be_merged'].includes(status))
    return { kind: 'blocked', reason: 'PR 存在冲突或平台明确禁止合入' };
  if (
    detail.draft === true ||
    detail.work_in_progress === true ||
    human.has(status) ||
    detail.blocking_discussions_resolved === false ||
    detail.approvals_left > 0 ||
    detail.approved === false
  )
    return wait('等待人工审批、解除草稿或处理讨论', true);
  if (pipeline?.sha && pipeline.sha !== head) return wait('当前 CI 不属于冻结候选，等待本次提交的检查');
  if (pipeline && ['failed', 'canceled'].includes(pipeline.status))
    return {
      kind: 'blocked',
      reason: `CI ${pipeline.status}，请在原 PR 处理后恢复`,
    };
  if (pipeline?.status === 'manual') return wait('等待人工触发 CI 任务', true);
  if (activeCI.has(pipeline?.status)) return wait(`等待 CI · ${pipeline.status}`);
  if (checking.has(status)) return wait('等待平台完成 CI 或可合入性检查');
  // CodeHub may leave this lazy status unchecked; the SHA-protected merge endpoint remains authoritative.
  const mergeable = ['mergeable', 'can_be_merged', 'unchecked'].includes(status);
  if (pipeline?.status === 'success' && pipeline.sha === head && mergeable)
    return {
      kind: 'ready',
      reason:
        status === 'unchecked'
          ? '本次候选 CI 通过，交由平台在合入时校验最终规则'
          : '本次候选 CI 与平台合入条件通过',
    };
  return wait('平台尚未提供当前候选的完整合入条件；可打开原 PR 核对');
}

export function mergeWait(delivery, result, now, timeoutMs = 1800000) {
  const previous = delivery.autoMerge ?? {};
  const changed = previous.reason !== result.reason;
  const polls = changed ? 1 : (previous.pollCount ?? 0) + 1;
  const deadlineAt = previous.deadlineAt ?? new Date(now + timeoutMs).toISOString();
  return {
    ...previous,
    status: result.kind === 'pending' ? 'RESULT_PENDING' : result.kind === 'blocked' ? 'BLOCKED' : 'WAITING',
    head: delivery.candidate,
    reason: result.reason,
    manual: result.manual === true,
    observedAt: new Date(now).toISOString(),
    deadlineAt,
    pollCount: polls,
    nextCheckAt: new Date(now + Math.min(30000, polls * 10000)).toISOString(),
  };
}

export function validateMergeObservation(delivery, fail) {
  const value = delivery.autoMerge;
  const fields = [
    'status',
    'head',
    'reason',
    'manual',
    'observedAt',
    'deadlineAt',
    'pollCount',
    'nextCheckAt',
    'requestedAt',
    'confirmedAt',
    'lastError',
    'requestRejected',
  ];
  if (
    value &&
    (typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !fields.includes(key)) ||
      !['WAITING', 'INTENT_SAVED', 'RESULT_PENDING', 'MERGED', 'BLOCKED'].includes(value.status) ||
      ['manual', 'requestRejected'].some(
        (key) => value[key] !== undefined && typeof value[key] !== 'boolean',
      ) ||
      (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 2000)) ||
      (value.lastError &&
        (Object.keys(value.lastError).some((key) => !['code', 'message'].includes(key)) ||
          typeof value.lastError.code !== 'string' ||
          typeof value.lastError.message !== 'string')) ||
      (value.head !== undefined && value.head !== delivery.candidate))
  )
    fail('LEDGER_INVALID', '自动合入观察与冻结候选不一致，保留原记录');
  for (const field of ['observedAt', 'deadlineAt', 'nextCheckAt', 'requestedAt', 'confirmedAt'])
    if (value?.[field] !== undefined && !Number.isFinite(Date.parse(value[field])))
      fail('LEDGER_INVALID', '自动合入时间记录无效');
  if (value?.pollCount !== undefined && (!Number.isSafeInteger(value.pollCount) || value.pollCount < 0))
    fail('LEDGER_INVALID', '自动合入观察次数无效');
  const merged = delivery.mergeObservation;
  if (
    merged &&
    (Object.keys(merged).some((key) => !['source', 'head', 'url', 'observedAt'].includes(key)) ||
      merged.head !== delivery.candidate ||
      merged.url !== delivery.prUrl ||
      !['platform', 'git'].includes(merged.source) ||
      !Number.isFinite(Date.parse(merged.observedAt)))
  )
    fail('LEDGER_INVALID', '合入事实与原交付不一致');
}

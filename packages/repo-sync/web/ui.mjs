export const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
export const sha = (value) => `<code title="${esc(value)}">${esc(value ?? '未记录')}</code>`;
export const shortSha = (value) =>
  /^[a-f0-9]{40,64}$/i.test(value ?? '')
    ? `<span class="short-sha"><code title="${esc(value)}">${esc(value.slice(0, 12))}</code><button type="button" data-copy-sha="${esc(value)}" aria-label="复制完整 commit ID ${esc(value)}">复制</button><small data-copy-feedback role="status"></small></span>`
    : sha(value);
export const when = (value) =>
  value ? esc(new Date(value).toLocaleString('zh-CN', { hour12: false, timeZoneName: 'short' })) : '未记录';
export const button = (action, label) =>
  `<button type="button" class="primary" data-action="${esc(action)}">${esc(label)}</button>`;
export const labels = {
  COMPLETE: '已完成',
  CANCELLED: '已撤销',
  ISSUES_REQUIRED: '等待 Issue 映射',
  CODE_PREPARE_REQUIRED: '等待候选检查',
  PR_REQUIRED: '创建 PR',
  WAITING_APPROVAL: '等待审核合入',
  PUSH_RESULT_UNKNOWN: '推送结果待核对',
  CODE_ACCEPTED_PENDING_METADATA: 'Issue 接收记录待保存',
};
export const title = (delivery) =>
  delivery.source.tag ??
  (delivery.source.kind === 'commit'
    ? `主干提交 ${delivery.source.commit.slice(0, 12)}`
    : delivery.source.number
      ? `PR #${delivery.source.number}`
      : delivery.source.title);
export const stageOf = (delivery) =>
  ({
    ISSUES_REQUIRED: 2,
    CODE_PREPARE_REQUIRED: 2,
    PUSH_RESULT_UNKNOWN: 3,
    PR_REQUIRED: 3,
    WAITING_APPROVAL: 4,
    CODE_ACCEPTED_PENDING_METADATA: 5,
    COMPLETE: 5,
    CANCELLED: 0,
  })[delivery?.status] ?? 1;

export function completionTime(delivery, record) {
  return (
    delivery.finishedAt ??
    record?.events?.findLast((e) => e.deliveryId === delivery.id && e.stage === 'COMPLETE')?.time
  );
}
export function completionProof(key, delivery, record) {
  if (delivery?.status !== 'COMPLETE') return null;
  const completedAt = completionTime(delivery, record);
  if (key === 'acceptance-save' && delivery.acceptedInternal && completedAt)
    return `接收台账：${sha(delivery.target)} → ${sha(delivery.acceptedInternal)} · ${when(completedAt)}`;
  const lastId = delivery.taskIds?.at(-1);
  const task = record?.tasks?.find(
    (item) => item.id === lastId && item.status === 'SUCCEEDED' && item.finishedAt,
  );
  if (key === 'execution-record' && task && !record?.missingTasks?.includes(lastId))
    return `已读取本笔最终执行记录 · ${when(task.finishedAt)}。原记录保留，不补造独立步骤事件。`;
  return null;
}

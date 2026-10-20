import { fail } from './config.mjs';
import { phase } from './execution.mjs';
import { inspectCandidate, pauseRecovery } from './exit-inspection.mjs';
import { gitlabApi } from './gitlab-api.mjs';
import { event } from './store.mjs';

export function cancelDelivery(receiver, input) {
  if (input.confirmed !== true) fail('CANCEL_CONFIRMATION_REQUIRED', '请确认关闭旧 PR 并保留候选、Issue 和历史，然后退出本笔。');
  return receiver.change(async (state) => {
    const d = receiver.active(state);
    if (!d || d.id !== input.deliveryId) fail('DELIVERY_CHANGED', '活动交付已变化，未关闭其他 PR。');
    if (input.previousUrl !== (d.prUrl ?? '')) fail('PR_MAPPING_CHANGED', '原 PR 链接已改变，请刷新核对再退出。');
    if (d.repair) fail('REPAIR_PENDING', '已有修复 PR 流程，请完成原修复，不能撤销已合入的原交付。');
    await closeCandidate(receiver, state, d, input);
    d.status = 'CANCELLED';
    delete d.error;
    state.activeId = null;
    state.queue = [];
    if (state.automation) {
      Object.assign(state.automation, { scanned: false, restartOf: d.id, deliveryId: null,
        pauseRequested: { afterDeliveryId: null, requestedAt: new Date().toISOString() } });
      if (['queue', 'latest'].includes(state.automation.selection.kind))
        state.automation.selection = { kind: 'commit', value: state.automation.target ?? d.target };
      delete state.automation.error;
    }
    event(state, d, `本笔已退出（${d.cancellation.verifiedBy} 确认）；候选分支、Issue、映射和历史保留，接受游标未变化。明确继续后重新同步。`);
  });
}
export async function closeCandidate(receiver, state, d, input) {
  if (input.confirmed !== true) fail('CANCEL_CONFIRMATION_REQUIRED', '请明确确认关闭原 PR 并保留历史。');
  if (input.previousUrl !== (d.prUrl ?? '')) fail('PR_MAPPING_CHANGED', '原 PR 链接已改变，请刷新。');
  d.cancellation ??= { requestedAt: new Date().toISOString() };
  d.cancellation.status = 'REQUESTED';
  pauseRecovery(state, d);
  await phase('cancel-intent', '保存退出意图并暂停轮次', () => receiver.store.save(state), false);
  const report = await inspectCandidate(receiver, d), previous = d.exitInspection;
  d.exitInspection = report;
  assertUnmerged(d, report);
  if (report.kind === 'UNKNOWN') fail('PR_CREATE_RESULT_UNKNOWN', '原 PR 创建结果尚未查到；不能假设未创建，先核对原对象。');
  if (report.kind === 'MANUAL_REQUIRED') {
    if (!['closed', 'no-pr'].includes(input.manualDisposition) ||
        (input.manualDisposition === 'no-pr' && (d.prUrl || d.prCreation || d.gitPr)))
      fail('MANUAL_CLOSE_REQUIRED', '当前创建方式不能查询关闭状态。请先在平台关闭原 PR，再明确确认；仅分支且无创建意图时可确认尚未创建 PR。');
    if (!previous || input.inspectionId !== previous.id || previous.id !== report.id)
      fail('EXIT_INSPECTION_CHANGED', '先读取退出检查；main、候选或 PR 变化后需要重新核对。');
    Object.assign(d.cancellation, { verifiedBy: 'operator', manualDisposition: input.manualDisposition, inspectionId: report.id });
  }
  if (report.kind === 'OPEN_PR') {
    const id = /\/(\d+)$/.exec(report.pr.url)[1];
    await phase('cancel-pr', '关闭原内部 PR；丢失回执时只回读原对象', () =>
      gitlabApi(receiver.config, receiver.config.pullRequests, 'PR')
        .request(`merge_requests/${id}`, 'PUT', { state_event: 'close' }), false);
  }
  const final = await inspectCandidate(receiver, d);
  assertUnmerged(d, final);
  if (report.kind === 'MANUAL_REQUIRED' && final.id !== report.id)
    fail('EXIT_INSPECTION_CHANGED', '退出期间内部状态已改变，需要重新检查与确认。');
  if (final.pr && final.pr.state !== 'closed') fail('PR_CLOSE_PENDING', '关闭尚未确认；保留退出意图，继续回读原对象。');
  d.exitInspection = final;
  Object.assign(d.cancellation, { status: 'COMPLETE', completedAt: new Date().toISOString(),
    verifiedBy: d.cancellation.verifiedBy ?? (final.pr ? 'platform' : 'git') });
}
function assertUnmerged(d, report) {
  if (report.kind === 'MERGED') {
    d.cancellation.status = 'MERGED';
    fail('PR_ALREADY_MERGED', '原 PR 已合入；请预览并创建修复 PR，不能撤销或回退 main。');
  }
}

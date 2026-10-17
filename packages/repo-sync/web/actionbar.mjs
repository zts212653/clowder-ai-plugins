import { continuationControls } from './continuation-view.mjs';
import { failureSummary } from './error-guide.mjs';
import { esc } from './ui.mjs';

function control(p, primary) {
  const tone = primary ? 'primary' : '';
  const label = esc(p.label);
  if (p.href)
    return `<a class="button ${tone}" href="${esc(p.href)}" target="_blank" rel="noopener">${label}</a>`;
  if (p.anchor)
    return `<a class="button ${tone}" href="#${esc(p.anchor)}" data-reveal="${esc(p.anchor)}">${label}</a>`;
  if (!p.action && !p.special) return '';
  const attribute = p.action ? `data-action="${esc(p.action)}"` : `data-${p.special}`;
  return `<button type="button" class="${tone}" ${attribute}>${label}</button>`;
}
export function actionSignature(policy, snapshot) {
  const run = snapshot.state?.automation, task = snapshot.operation, d = snapshot.state?.active;
  return JSON.stringify([policy, run?.id, d?.id, run?.autoMerge, run?.continuation, run?.pauseRequested,
    task?.status, task?.error, task?.persistence?.status, d?.error, d?.prUrl]);
}
export function actionBar(policy, historical, snapshot = {}) {
  if (historical) return '';
  const failure = failureSummary(snapshot);
  const run = snapshot.state?.automation;
  const pause = run && ['RUNNING', 'WAITING_REVIEW'].includes(run.status) && !run.pauseRequested;
  const pauseStatus = run?.pauseRequested
    ? '<small class="pause-boundary-note">已设置：本笔完成后暂停，下一笔不会自动开始。</small>'
    : '';
  const code = failure?.code;
  const passiveFailure = ['GITHUB_AUTH_REQUIRED', 'GITHUB_AUTH_INVALID', 'ISSUE_AUTH_REQUIRED', 'RECORD_NOT_FOUND', 'INVALID_RECORD_QUERY'].includes(code);
  const operation = snapshot.operation;
  const stuck = operation?.status === 'STOP_UNCONFIRMED';
  const recordFailed = operation?.persistence?.status === 'FAILED';
  const needsHuman = (Boolean(failure) && !passiveFailure) || stuck || recordFailed || policy.special === 'cancel-operation';
  const actionLabel = needsHuman ? '需要你处理' : (failure || policy.href || policy.action || policy.anchor || policy.secondary) ? '轮到你了' : '系统正在处理';
  const fallback = failure && !failure.repair ? '<a class="button" href="#flow-inspector" data-reveal="flow-inspector">查看失败步骤 →</a>' : '';
  const description = needsHuman ? '先完成下面的修复动作；原对象和已完成结果会保留。' : policy.href ? '完成后系统会自动回到本轮流程并继续核验。' : '当前阶段会在此处更新，页面刷新后仍可继续。';
  return `<section class="next-action now" data-policy="${esc(actionSignature(policy, snapshot))}" aria-label="当前操作区"><p class="now-kicker">${actionLabel}</p><h2>${esc(policy.text)}</h2><p class="now-description" role="status">${description}${pauseStatus}</p>${failure?.html ?? ''}<div class="task-actions">${failure?.repair || fallback || control(policy, true)}${policy.secondary ? control(policy.secondary, false) : ''}${pause ? '<button type="button" data-action="pause-sync">本笔完成后暂停</button>' : ''}</div><div class="run-options">${run && run.status !== 'COMPLETE' ? `<details class="auto-merge-options" data-persist-details="merge-options"><summary>本轮自动合入：${run.autoMerge ? '已开启' : '关闭'} · 修改</summary>${autoMergeControls(snapshot)}</details>` : ''}<details data-persist-details="continuation"><summary>本轮接收节奏</summary>${continuationControls(snapshot)}</details></div></section>`;
}
function autoMergeControls(snapshot) {
  const run = snapshot.state?.automation;
  if (!run || run.status === 'COMPLETE') return '';
  const enabled = snapshot.config?.prTransport === 'gitlab' || snapshot.platform?.transport === 'gitlab';
  const delivery = snapshot.state?.active;
  const waiting = run.status === 'WAITING_REVIEW' && delivery?.status === 'WAITING_APPROVAL';
  return `<form class="auto-merge-choice" data-form="configure-auto-merge" data-edit-baseline="${esc(JSON.stringify([run.id, delivery?.id, run.autoMerge === true]))}"><input type="hidden" name="runId" value="${esc(run.id)}"><input type="hidden" name="deliveryId" value="${esc(delivery?.id ?? '')}"><label><input type="checkbox" name="autoMerge" ${run.autoMerge === true ? 'checked' : ''} ${enabled ? '' : 'disabled data-preserve-disabled'}>本轮允许平台自动合入</label><details class="tech"><summary>为什么？</summary><div class="tech-copy">默认关闭。仅在检查通过且平台审批 / 分支规则允许时请求合入；保留提交，不使用 squash。${waiting ? '保存后自动等待 CI 和平台条件，通过后才请求合入。' : ''}</div></details><p data-edit-note role="status" hidden>有未保存修改；以保存后的选择为准。</p><button type="submit" ${enabled ? '' : 'disabled data-preserve-disabled'}>保存自动合入选择</button>${enabled ? '' : '<p>当前创建方式没有合入 API，请在本项目设置中配置兼容平台接口。</p>'}</form>`;
}

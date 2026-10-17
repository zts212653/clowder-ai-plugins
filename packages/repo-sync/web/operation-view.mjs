import { errorGuide } from './error-guide.mjs';
import { taskProgress } from './task-progress.mjs';
const labels = {
  RUNNING: '正在执行',
  CANCELLING: '正在停止进程树',
  STOP_UNCONFIRMED: '停止结果待确认',
  SUCCEEDED: '执行完成',
  FAILED: '执行失败',
  CANCELLED: '已取消',
  INTERRUPTED: '执行中断',
};
const actions = {
  'inspect-baseline': '核验同步起点（尚未启用）',
  'preview-sync': '只读预览同步范围',
  synchronize: '自动同步',
  'resume-sync': '恢复原轮次',
  'pause-sync': '停止后续自动处理',
  heads: '两侧连接检查',
  adopt: '已有基线核验',
  prepare: '准备同步候选',
  recover: '核验并恢复原交付',
  tags: '读取上游 tag',
  discover: '读取上游交付',
  'select-tag': '核对目标版本',
  pr: '登记 / 纠正内部 PR 引用',
  'clear-pr': '撤销错误 PR 引用',
  'create-pr': '查询 / 自动创建内部 PR',
  start: '冻结并发起本次交付',
  issue: '登记 / 纠正 Issue 来源映射',
  receipts: '核对 Issue 接收记录',
  resolve: '保存冲突处理',
  'cancel-version': '撤销未发布版本',
};
const marks = { DONE: '✓', RUNNING: '●', FAILED: '×', PENDING: '○' };
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
function stepView(step) {
  const progress = taskProgress(step, esc);
  const error = step.error ? `<small>× ${esc(step.error.code)}：${esc(step.error.message)}</small>` : '';
  return `<li data-operation-state="${esc(step.status)}" class="${step.status === 'FAILED' ? 'bad' : step.status === 'DONE' ? 'good' : ''}">${marks[step.status] ?? '○'} ${esc(step.label)}${progress}${error}</li>`;
}
export function renderTask(task) {
  if (!task) return '';
  const end = task.finishedAt ? Date.parse(task.finishedAt) : Date.now();
  const elapsed = Math.max(0, Math.floor((end - Date.parse(task.startedAt)) / 1000));
  const badge = `${esc(labels[task.status] ?? task.status)} · ${elapsed} 秒 · 状态最近成功读取 ${esc(task.observedAt ?? '未记录')}`;
  const steps = `<ol class="operation-steps">${task.steps.map(stepView).join('')}</ol>`;
  const error =
    task.status === 'FAILED'
      ? errorGuide(task.error, { action: actions[task.action] ?? task.action, deliveryId: task.deliveryId })
      : errorView(task);
  const cancel = task.cancellable
    ? `<button type="button" data-cancel-operation>${task.action === 'prepare' ? '取消候选准备' : '取消当前读取 / 下载'}</button>`
    : '';
  const waiting =
    task.status === 'CANCELLING'
      ? '<p>确认进程树退出后才释放执行锁，请等待。</p>'
      : task.status === 'RUNNING'
        ? '<p>正在查询原任务。可以切换页面查看信息，修改配置和重复执行暂时锁定。</p>'
        : '';
  const heads = task.result?.upstream
    ? `<p>外部当前：<code>${esc(task.result.upstream)}</code><br>内部当前：<code>${esc(task.result.internal)}</code></p>`
    : '';
  const retry =
    task.action === 'heads' && task.status === 'FAILED'
      ? '<button type="button" data-action="heads">重新检查两侧连接</button>'
      : '';
  const auth = githubRecovery(task) + targetRecovery(task);
  const detail = `${steps}${error}${auth}${cancel}${waiting}${heads}${retry}<small>任务 ${esc(task.id)}；百分比属于当前 Git 下载阶段。</small>`;
  if (task.persistence?.status === 'FAILED') return recordPending(task, detail);
  if (task.status === 'SUCCEEDED')
    return `<section class="card"><details><summary>✓ ${esc(actions[task.action])}完成 · ${elapsed} 秒 · 查看执行记录</summary>${detail}</details></section>`;
  return `<section class="card task"><span class="badge">${badge}</span><h2>${esc(actions[task.action])}</h2>${detail}</section>`;
}
function githubRecovery(task) {
  return /^GITHUB_(AUTH|ACCESS|RATE)/.test(task.error?.code ?? '')
    ? '<button type="button" data-view="configuration" data-auth-focus="github">配置 GitHub 读取认证</button><p>提供令牌后回到目标版本，重新读取 PR 清单。原同步记录保留。</p>'
    : '';
}
function targetRecovery(task) {
  if (task.error?.code === 'DIRECT_COMMITS_CONFIRMATION_REQUIRED')
    return '<p>上方目标表单可以明确包含这些无 PR 主干提交，然后重新读取同一目标；每笔仍需在内部平台审核。原队列和接收基线未推进。</p>';
  return [
    'TARGET_NOT_ON_SOURCE_BRANCH',
    'TARGET_NOT_MAIN_BOUNDARY',
    'TARGET_NOT_FORWARD',
    'VERSION_NOT_FORWARD',
  ].includes(task.error?.code)
    ? '<p>本次目标未被接受，原基线、同步历史和内部代码保持不变。回到上方目标输入选择有效版本后可重试。需要改用另一种同步模式时，请新增独立项目；不要重置或覆盖原台账。</p><button type="button" data-view="configuration">查看当前仓库与同步模式</button>'
    : '';
}
function recordPending(task, detail) {
  const repair = task.persistence.canRetry
    ? '<button type="button" data-persist-operation>只补存原任务记录</button>'
    : '<p>请回到拥有该任务的执行器核对，不能在这里重跑业务。</p>';
  return `<section class="card task"><span class="badge">记录待保存 · 业务状态：${esc(labels[task.status])}</span><h2 class="bad">只补存执行记录</h2><p class="bad">× ${esc(task.persistence.error.code)}：${esc(task.persistence.error.message)}</p>${repair}${detail}</section>`;
}
function errorView(task) {
  if (
    !task.error ||
    task.steps.some((step) => step.error?.code === task.error.code && step.error.message === task.error.message)
  )
    return '';
  return `<p class="bad">× ${esc(task.error.code)}：${esc(task.error.message)}</p>`;
}

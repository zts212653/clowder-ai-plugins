import { COMPLETE } from './data.mjs';
import { bindingSummary } from './render-binding.mjs';
import { renderWorkflow } from './render-delivery.mjs';
import { renderQueue } from './render-flow.mjs';
import { renderTask, renderVersions } from './render-task.mjs';
import { summary } from './state.mjs';
import { taskContext } from './task-model.mjs';

export function renderOverview(state, selectedPhase, technicalOpen = false) {
  const delivery = taskContext(state);
  const status = summary(state);
  const current = state.active && state.active.phase < COMPLETE ? '处理中' : '已完成';
  const versionLabel =
    state.binding.status !== 'ready'
      ? '等待配置'
      : status.codeLatest
        ? '代码已是最新'
        : `待接收 ${status.behindCommits} 个提交 · ${status.behind} 笔 PR 交付`;
  return `<div class="workbench-status"><span class="badge ${status.fullyComplete ? 'good' : 'neutral'}">${versionLabel}</span><small>按上游顺序接收 · 一次处理一笔</small></div>${bindingSummary(state.binding)}${renderTask(state, delivery)}
    ${renderVersions(state, delivery)}${delivery ? `<details id="technical-details" class="technical-disclosure" ${technicalOpen ? 'open' : ''}><summary>查看完整流程与命令说明</summary>${renderWorkflow(state, delivery, selectedPhase)}</details>` : ''}
    ${state.binding.status === 'ready' ? `<section class="panel queue-panel"><div class="section-head"><div><h2>同步记录与待接收更新</h2><p>点击一笔更新查看详情；下一笔会在当前同步完成后开放。</p></div><span class="count">${state.deliveries.length}</span></div><div class="delivery-list">${renderQueue(state, current)}</div></section>` : '<div class="getting-started"><h3>配置后你可以做什么</h3><p>发现上游已合入的 PR → 同步到内部 → 在内部 PR 完成审核 → 系统核验并登记结果。</p></div>'}`;
}

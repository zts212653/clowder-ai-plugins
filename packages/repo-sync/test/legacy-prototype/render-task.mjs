import { deliveryNames, deliveryPhase } from './delivery.mjs';
import { escapeHtml, sha } from './html.mjs';
import { renderProgress } from './progress.mjs';
import { taskModel } from './task-model.mjs';

function actionButton(action) {
  if (action.href)
    return `<a id="${action.id}" class="button primary" href="${action.href}" target="_blank" rel="noopener">${escapeHtml(action.label)}</a>`;
  const data = action.view
    ? `data-view="${action.view}"`
    : action.delivery
      ? `data-audit="${escapeHtml(action.delivery)}"`
      : action.help
        ? `data-help="${escapeHtml(action.help)}"`
        : '';
  return `<button type="button" ${action.id ? `id="${action.id}"` : ''} ${data} class="button primary">${escapeHtml(action.label)}</button>`;
}
export function renderTask(state, delivery, detailsOpen = false) {
  const model = taskModel(state, delivery, detailsOpen);
  const phase = delivery ? deliveryPhase(state, delivery) : 0;
  const names = delivery ? deliveryNames(delivery, state.binding) : null;
  return `<section id="current-task" class="panel task-card ${model.tone}" aria-label="当前操作"><div class="task-main"><div><span class="badge ${model.tone}">${model.actor}</span><h2>${model.title}</h2><p>${escapeHtml(model.description)}</p></div><div class="task-action">${actionButton(model.action)}<small>点击这里完成当前这一步</small></div></div>
    ${delivery ? `<div class="task-subject"><div><small>${phase ? '本次同步' : '下一笔更新'} · 外部 PR #${delivery.sourcePr}${phase >= 4 ? ` → 内部 PR #${delivery.internalPr}` : ''}</small><h3>${escapeHtml(delivery.title)}</h3><div class="branch-path"><span>内部分支</span><code>${escapeHtml(names.candidateBranch)}</code><span>→</span><code>${escapeHtml(names.targetBranch)}</code></div><details class="pr-name"><summary>查看内部 PR 标题</summary><p>${escapeHtml(names.prTitle)}</p></details></div>${!detailsOpen ? `<button type="button" class="text-button" data-delivery="${escapeHtml(delivery.id)}">查看本次同步详情 →</button>` : ''}</div>${renderProgress(state, delivery)}` : ''}</section>`;
}
export function renderVersions(state, delivery) {
  if (state.binding.status !== 'ready') return '';
  return `<section class="versions-inline" aria-label="内外版本对应关系"><div><small>外部最新</small>${sha(state.latest)}</div><div><small>已接受上游</small>${sha(state.accepted)}</div><div><small>内部 ${escapeHtml(state.binding.targetBranch)}</small>${sha(state.internalSha)}</div>${delivery ? `<button type="button" class="text-button" data-map="${escapeHtml(delivery.id)}">查看版本与对象对照 →</button>` : ''}</section>`;
}

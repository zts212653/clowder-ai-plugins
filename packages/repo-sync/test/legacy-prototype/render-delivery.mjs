import { renderAudit } from './audit.mjs';
import { phases } from './data.mjs';
import { deliveryNames, deliveryPhase, prHref } from './delivery.mjs';
import { escapeHtml } from './html.mjs';
import { renderObjects, renderPhase } from './render-detail.mjs';
import { renderFlow } from './render-flow.mjs';
import { renderTask, renderVersions } from './render-task.mjs';

export function renderIdentity(delivery, binding, phase) {
  const names = deliveryNames(delivery, binding);
  return `<div class="delivery-identity"><div><small>内部候选分支 → 合入分支</small><div class="branch-path"><code>${escapeHtml(names.candidateBranch)}</code><span>→</span><code>${escapeHtml(names.targetBranch)}</code><span class="badge neutral">${phase >= 4 ? '候选已推送' : '名称预览'}</span></div></div><div><small>内部 PR 标题${phase < 4 ? '（预览）' : ''}</small><strong>${escapeHtml(names.prTitle)}</strong></div><p>分支按交付 ID 生成；同一笔交付重试复用同名分支与 PR。目标分支按仓库连接配置。</p></div>`;
}
export function renderWorkflow(state, delivery, selectedPhase, detailsOpen = false) {
  const phase = delivery ? deliveryPhase(state, delivery) : 0;
  const flowState = delivery
    ? { ...delivery, phase, block: state.active?.id === delivery.id ? state.active.block : null }
    : null;
  const current = phase ? phases[phase] : '待开始同步';
  return `<section class="panel flow-panel"><div class="section-head"><div><h2>交付流程</h2><p>${delivery ? `${escapeHtml(delivery.id)} · 当前执行：${current}` : '从冻结目标开始，逐步构建内部可审批的交付。'}</p></div>${delivery && !detailsOpen ? `<button type="button" class="text-button" data-delivery="${escapeHtml(delivery.id)}">交付详情与审计 →</button>` : '<span class="badge neutral">点击节点查看说明</span>'}</div>
    ${delivery ? renderIdentity(delivery, state.binding, phase) : ''}<div class="flow">${renderFlow(flowState, selectedPhase)}</div>
    ${renderPhase(state, selectedPhase, delivery)}
    <p class="flow-help">点击节点用于查看说明，不改变执行进度。进度以当前阶段为准。</p></section>`;
}
export function renderDelivery(state, selectedId, selectedPhase, options = {}) {
  const delivery = state.deliveries.find((item) => item.id === selectedId);
  if (!delivery || state.binding.status !== 'ready') return '<div class="notice">此交付不可用，请返回同步总览。</div>';
  const phase = deliveryPhase(state, delivery);
  const frozen = state.active?.id === delivery.id ? state.active : delivery;
  const auditCount = state.events.filter((event) => event.deliveryId === delivery.id).length;
  return `<button type="button" class="text-button" data-view="overview">← 返回同步工作台</button>${renderTask(state, frozen, true)}${renderVersions(state, delivery)}
    ${state.active?.id === delivery.id && state.active.block === 'drift' ? '<section class="panel help-card" id="baseline-help"><h3>怎样处理基线差异</h3><ol><li>在内部仓核对核心代码相对已接受上游版本的差异。</li><li>将内部业务定制放到独立插件，确认核心代码保持一致。</li><li>确认初始化映射后重新核验基线，再继续同步。</li></ol><p>此场景需要真实差异核对，演示不会直接覆盖内部代码。</p><button type="button" id="recover" class="button secondary" disabled>等待基线核对完成</button></section>' : ''}
    <div class="detail-tools"><button type="button" class="text-button" data-audit="${escapeHtml(delivery.id)}">查看本次审计（${auditCount} 条）</button>${phase >= 4 && phase !== 6 ? `<a class="text-button" href="${prHref(state, delivery.internalPr)}" target="_blank" rel="noopener">打开内部 PR #${delivery.internalPr} ↗</a>` : ''}</div>
    <details id="technical-details" class="technical-disclosure" ${options.technicalOpen ? 'open' : ''}><summary>查看完整流程与命令说明</summary>${renderWorkflow(state, frozen, selectedPhase, true)}</details>
    <details id="check-details" class="technical-disclosure"><summary>查看检查结果与 Issue / PR 状态</summary><section class="panel delivery-objects">${renderObjects(state, delivery)}</section></details>
    <details id="delivery-audit" class="technical-disclosure" ${options.auditOpen ? 'open' : ''}><summary>本次同步审计（${auditCount} 条）</summary>${renderAudit(state, delivery.id)}</details>`;
}

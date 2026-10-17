import { renderAudit } from './audit.mjs';
import { COMPLETE } from './data.mjs';
import { deliveryNames } from './delivery.mjs';
import { escapeHtml } from './html.mjs';
import { reduce } from './state.mjs';
import { readState, storageKey, writeState } from './storage.mjs';

const prNumber = Number(location.pathname.split('/').at(-1));
const bindingId = new URL(location.href).searchParams.get('binding');
const content = document.getElementById('pr-content');
const bindingValid = (state) => state.binding.status === 'ready' && (!bindingId || bindingId === state.binding.id);
const namesForPr = (active, delivery, binding) => deliveryNames(active ?? delivery, binding);
function render() {
  const state = readState();
  if (!bindingValid(state)) {
    content.textContent = '仓库绑定已更换或尚未初始化。此旧 PR 页面不能操作当前交付，请从同步总览重新打开。';
    return;
  }
  const delivery = state.deliveries.find((item) => item.internalPr === prNumber);
  if (!delivery) {
    content.textContent = '此模拟 PR 没有对应交付，请返回同步总览选择一个具体 PR。';
    return;
  }
  const active = state.active?.id === delivery.id ? state.active : null;
  const index = state.deliveries.indexOf(delivery);
  const acceptedIndex = state.deliveries.findIndex((item) => item.target === state.accepted);
  const phase = active?.phase ?? (index <= acceptedIndex ? COMPLETE : 0);
  const merged = phase >= 7;
  const canMerge = phase === 6 && !active.block;
  const names = namesForPr(active, delivery, state.binding);
  content.innerHTML = `<section class="page-heading"><div><div class="eyebrow">PULL REQUEST · 平台页面模拟</div><h1>${escapeHtml(names.prTitle)} <span class="muted">#${prNumber}</span></h1><p>${escapeHtml(names.candidateBranch)} → ${escapeHtml(names.targetBranch)} · 来源：外部 PR #${delivery.sourcePr}</p><p>${escapeHtml(state.binding.internalUrl)}</p></div><span class="badge ${merged ? 'good' : 'warm'}">${merged ? '已合入' : '待审核'}</span></section>
    <section class="panel"><div class="section-head"><div><h2>同步 PR 说明</h2><p>由确定性模板生成；此演示无需 Agent。</p></div></div><dl class="object-list"><div><dt>固定交付</dt><dd>${delivery.id}</dd></div><div><dt>来源目标</dt><dd><code>${delivery.target}</code></dd></div><div><dt>实际落地提交</dt><dd>${delivery.commits.join(' / ')}</dd></div><div><dt>Issue 对应</dt><dd>外部 #${delivery.issue} → 内部 #${delivery.internalIssue}</dd></div><div><dt>必需检查</dt><dd>${canMerge || merged ? '核心与插件检查已通过' : '当前不满足合入条件'}</dd></div></dl></section>
    ${merged ? '<div class="notice success">平台已模拟合入。同步总览会读取这个结果，再自动核验代码与 Issue 状态；无需在同步工具内再次审批。</div>' : `<section class="panel pr-review"><h2>在平台完成审核与合入</h2><p>实际使用中由内部平台执行权限、审批与分支保护。这里仅演示页面交接。</p><form id="platform-merge"><label for="platform-note">模拟审核备注</label><textarea id="platform-note" rows="3" required placeholder="输入一段演示备注" ${canMerge ? '' : 'disabled'}></textarea><button type="submit" class="button primary" ${canMerge ? '' : 'disabled'}>模拟在平台合入 PR #${prNumber}</button></form></section>`}
    ${renderAudit(state, delivery.id)}`;
}
document.addEventListener('submit', (event) => {
  if (event.target.id !== 'platform-merge') return;
  event.preventDefault();
  const state = readState();
  if (!bindingValid(state) || state.active?.internalPr !== prNumber || state.active.phase !== 6 || state.active.block) {
    render();
    return;
  }
  const note = document.getElementById('platform-note').value.trim();
  if (!note) return;
  writeState(reduce(state, { type: 'approve', note }));
  render();
});
window.addEventListener('storage', (event) => {
  if (event.key === storageKey) render();
});
render();

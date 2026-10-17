export function receiptFields(active, state, esc, sha) {
  return active.issues
    .map((issue) => {
      const mapping = state.issues[issue.sourceId];
      const waiting = state.queue.slice(1).filter((plan) => (issue.requiredTargets ?? []).includes(plan.target));
      return `<div><h3><a href="${esc(mapping.url)}" target="_blank" rel="noopener">打开内部 Issue #${esc(mapping.internalId)} ↗</a></h3><details class="tech"><summary>为什么？</summary><div class="tech-copy">${waiting.length ? `本笔已接收，仍待后续 ${waiting.map((plan) => esc(title(plan))).join(' / ')}；Issue 应保持打开。` : issue.relation === 'closes' ? '接收条件已满足，请在平台核对是否关闭，再登记实际状态。' : '目前只有关联证据，保留平台已有状态。'}</div></details><label>平台实际状态<select name="${esc(issue.sourceId)}"><option value="open" ${mapping.state !== 'closed' ? 'selected' : ''}>打开</option><option value="closed" ${mapping.state === 'closed' ? 'selected' : ''}>已关闭</option></select></label><details><summary>查看接收条件 SHA</summary><small>${(issue.requiredTargets ?? [active.target]).map(sha).join(' / ')}</small></details></div>`;
    })
    .join('');
}

import { title } from './ui.mjs';

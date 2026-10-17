import { phases } from './data.mjs';
import { deliveryNames, deliveryPhase } from './delivery.mjs';
import { escapeHtml } from './html.mjs';
import { stepFailure } from './progress.mjs';

export function seedAudit(state) {
  if (state.binding.status !== 'ready') return;
  for (const delivery of state.deliveries) {
    const phase = deliveryPhase(state, delivery);
    if (!phase) continue;
    const names = deliveryNames(delivery, state.binding);
    const failure = state.active?.id === delivery.id ? stepFailure(state.active) : null;
    state.events.push({
      deliveryId: delivery.id,
      phase,
      actor: '演示预置',
      time: '预置',
      label: `载入“${phases[phase]}”演示场景`,
      note: `预置状态，未执行真实命令。${names.candidateBranch} → ${names.targetBranch}；来源 PR #${delivery.sourcePr}；冻结目标 ${delivery.target}。${failure ? `演示异常：${failure.code} · ${failure.message}` : ''}`,
    });
  }
}
export function renderAudit(state, deliveryId) {
  const scoped = state.events.filter((event) => event.deliveryId === deliveryId);
  const ambiguous = (event) => event.label === '外部新交付加入队列' && event.note === '当前交付目标保持冻结';
  const events = scoped.filter((event) => !ambiguous(event));
  return `<section class="panel audit-panel" aria-label="本次同步审计"><div class="section-head"><div><h2>本次同步审计</h2><p>${escapeHtml(deliveryId)} · 仅展示这一笔交付 · 按记录顺序 · 合成数据</p></div><span class="badge neutral">${events.length} 条记录</span></div>${scoped.some(ambiguous) ? '<div class="empty">旧版发现记录未包含来源身份，归属待核对；原记录保留，未计入本次审计。</div>' : ''}${events.length ? `<ol class="event-list">${events.map((event) => `<li><span class="event-dot"></span><div><strong>${escapeHtml(event.label)}</strong><p>${escapeHtml(event.note)}</p><small>${escapeHtml(event.actor ?? '旧版记录：执行方未记录')}${event.phase != null ? ` · 阶段：${escapeHtml(phases[event.phase])}` : ''}</small></div><time>${escapeHtml(event.time ?? '演示')}</time></li>`).join('')}</ol>` : '<div class="empty">尚无本次逐步执行记录。待同步交付开始后记录；旧版或预置交付不会补造真实操作日志。</div>'}</section>`;
}

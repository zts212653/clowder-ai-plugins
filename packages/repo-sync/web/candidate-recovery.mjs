import { esc, shortSha } from './ui.mjs';

const labels = { LOCAL_ONLY: '仅本地候选，可保留历史并退出', BRANCH_ONLY: '已发布分支，平台确认尚无 PR',
  OPEN_PR: '原 PR 未合入，退出时将关闭并回读', CLOSED_PR: '原 PR 已关闭，可完成退出',
  MANUAL_REQUIRED: '当前方式不能查询关闭状态，需要人工确认', UNKNOWN: '创建结果不明，先核对原 PR，不能假设未创建',
  MERGED: '原候选已合入，使用新修复 PR，不能撤销 main' };
export function candidateRecovery(d, historical) {
  if (historical) return d.repair || d.repairHistory?.length ? `<section class="candidate-recovery"><h3>原交付的修复记录</h3>${repairSummary(d)}${archivedRepairs(d)}</section>` : '';
  if (['COMPLETE', 'CANCELLED'].includes(d.status)) return '';
  const report = d.exitInspection, merged = report?.kind === 'MERGED' || Boolean(d.repair);
  const prePublish = !d.prUrl;
  return `<section class="candidate-recovery" id="candidate-recovery" aria-label="退出与修复当前同步">
    <h3>撤销或修复本笔同步</h3><p>冻结错了、候选有误时从这里处理。退出检查只读取内部仓库和原 PR，不要求旧候选通过内容检查，也不读取 GitHub。</p>
    <button type="button" data-action="inspect-exit">检查原候选与 PR 状态</button>
    ${report ? `<p role="status"><b>${esc(labels[report.kind])}</b></p><p>检查时间 ${esc(report.observedAt)} · 内部 main ${shortSha(report.internal)}</p>` : '<p>先检查当前状态，再决定撤销或修复。原 Issue、映射和历史始终保留。</p>'}
    ${merged ? repairControls(d) + retireControls(d) : exitControls(d, { prePublish })}
    ${archivedRepairs(d)}
    </section>`;
}
function fields(d, ownerId = d.id) {
  return `<input type="hidden" name="deliveryId" value="${esc(ownerId)}"><input type="hidden" name="previousUrl" value="${esc(d.prUrl ?? '')}">`;
}
function exitControls(d, { action = 'cancel-delivery', ownerId = d.id, planId, prePublish = !d.prUrl } = {}) {
  const r = d.exitInspection, manual = r?.kind === 'MANUAL_REQUIRED';
  const repair = action === 'retire-repair';
  if (r?.kind === 'UNKNOWN') return '<p>请先核对原 PR 创建回执，并登记正确的原 PR 链接；不会另建对象。</p>';
  return `<details class="delivery-cancel" ${r || d.cancellation?.status === 'REQUESTED' ? 'open' : ''}><summary>${repair ? '退出这笔未合入的修复候选' : prePublish ? '撤销本笔（尚未发布）…' : '撤销本笔（已发布未合入）…'}</summary>
    <p>放弃本笔并重新同步：关闭未合入的旧 PR 后退出，保留候选分支、Issue 和历史。本轮暂停；明确继续才创建新分支和替代 PR，不回退 main。</p>
    <form id="${action === 'cancel-delivery' ? 'cancel-delivery-form' : 'retire-repair-form'}" data-form="${action}" data-edit-baseline="${esc(JSON.stringify([d.id, d.prUrl, d.candidate, d.status, r?.id, d.cancellation?.requestedAt]))}">
    ${fields(d, ownerId)}${planId ? `<input name="planId" type="hidden" value="${esc(planId)}">` : ''}${manual ? `<input type="hidden" name="inspectionId" value="${esc(r.id)}"><label>平台人工核对结果<select name="manualDisposition" required><option value="">请选择实际结果</option><option value="closed">我已在平台关闭原 PR，且未合入</option>${!d.prUrl && !d.prCreation && !d.gitPr ? '<option value="no-pr">我已确认平台尚未创建 PR</option>' : ''}</select></label><p>此结果记录为人工确认，不会显示为 API 核验。先完成平台操作，再确认退出。</p>` : ''}
    <label><input type="checkbox" name="confirmed" required>我确认撤销本笔，并保留原 Issue 与历史</label><small>刷新、候选或 PR 变化后需重新确认。</small>
    <button type="submit">${repair ? '关闭或回读原修复 PR，保留记录并退出' : d.cancellation?.status === 'REQUESTED' ? '回读并完成原 PR 撤销' : '关闭旧 PR 并撤销本笔'}</button></form></details>`;
}
function repairSummary(d) {
  const r = d.repair?.delivery;
  return r ? `<p>原 candidate ${shortSha(d.candidate)} → 修复 candidate ${shortSha(r.candidate)}${r.acceptedInternal ? ` → 接受 ${shortSha(r.acceptedInternal)}` : ''}</p>
    <p>修复分支 <code>${esc(r.branch)}</code> · ${esc(d.repair.status)}</p>${r.prUrl ? `<a href="${esc(r.prUrl)}" target="_blank" rel="noopener">打开修复 PR ↗</a>` : ''}` : '';
}
function archivedRepairs(d) {
  return (d.repairHistory ?? []).map((old) => `<details><summary>已退出的修复 ${esc(old.delivery.id)}</summary>
    ${repairSummary({ ...d, repair: old })}<p>冻结基线 ${shortSha(old.plan.internal)} · 上游 ${shortSha(old.plan.target)} · ${esc(old.delivery.cancellation?.completedAt ?? '')}</p></details>`).join('');
}
function retireControls(d) {
  const r = d.repair?.delivery;
  if (!r || d.repair.status === 'COMPLETE') return '';
  return `<details class="repair-retire"><summary>修复候选也需调整？退出未合入的修复 PR 后重新预览</summary>
    <p>先检查修复 PR 状态。只关闭此修复 PR；原同步、Issue 和修复历史均保留。</p>
    <button type="button" data-action="inspect-repair-exit">检查修复 PR 退出条件</button>
    ${r.exitInspection ? `<p>${esc(labels[r.exitInspection.kind])}</p>` : ''}
    ${r.exitInspection?.kind === 'MERGED' ? '<p>此修复已合入，请核验其结果，不能撤销。</p>' : exitControls(r, { action: 'retire-repair', ownerId: d.id, planId: d.repair.planId })}</details>`;
}
function repairControls(d) {
  const r = d.repair?.delivery, plan = d.repairPlan;
  if (d.repair?.status === 'COMPLETE') return `${repairSummary(d)}<p>修复代码已核验，继续核对原 Issue 的接收和关单结果。</p>`;
  if (r?.prUrl) return `${repairSummary(d)}<p>请在平台审核合入修复 PR，再核验结果。普通同步保持暂停。</p><button type="button" data-action="check-repair">已合入修复 PR，核验并完成原 Issue</button>`;
  return `${repairSummary(d)}${!d.repair ? '<button type="button" data-action="preview-repair">预览修复 PR 的文件差异</button>' : ''}
    ${plan ? `<p>修复基线 ${shortSha(plan.internal)} · 上游 landing ${shortSha(plan.target)}</p><pre>${esc(plan.changes || '文件树无需变化，仍核验原接收记录')}</pre>
    <form id="prepare-repair-form" data-form="prepare-repair" data-edit-baseline="${esc(plan.id)}">${fields(d)}<input type="hidden" name="planId" value="${esc(plan.id)}"><label><input type="checkbox" name="confirmed" required>我确认以上差异，通过独立 PR 修复并保留原历史</label><button type="submit">${r ? '回读并继续原修复 PR' : '检查并创建修复 PR'}</button></form>` : ''}
    ${r?.candidate ? `<form data-form="link-repair" data-edit-baseline="${esc(JSON.stringify([r.id, r.candidate, r.base.internal]))}">${fields({ ...d, prUrl: r.prUrl })}<label>已创建的修复 PR 地址<input name="url" type="url" required></label><label><input name="confirmed" type="checkbox" required>确认此 PR 的分支和 SHA 与修复候选一致</label><button type="submit">登记原修复 PR 地址（不重新创建）</button></form>` : ''}`;
}
export function recoveryPolicy(d) {
  if (!d) return null;
  if (d.repair?.status === 'COMPLETE') return null;
  if (d.repair || d.exitInspection?.kind === 'MERGED' || d.cancellation?.status === 'MERGED')
    return { stage: 5, text: '原 PR 已合入；通过独立修复 PR 恢复文件树，保留原历史与 Issue。本轮暂停。',
      anchor: 'candidate-recovery', label: '处理原交付的修复 PR →' };
  if (d.cancellation?.status === 'REQUESTED' || d.exitInspection || d.error?.code === 'CANDIDATE_TREE_MISMATCH')
    return { stage: 4, text: '先处理原候选的退出检查；保留 Issue、历史和接受游标。关闭结果不明时只回读原 PR。',
      anchor: 'candidate-recovery', label: '检查并退出旧候选 →' };
  return null;
}

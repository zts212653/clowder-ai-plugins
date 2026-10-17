import { issueReferenceNotes } from './issue-reference-notes.mjs';
import { esc, shortSha } from './ui.mjs';

export function deliveryOverview(snapshot, _record, d, historical) {
  const version = d.mode === 'version';
  const development = d.source.developmentCommitCount ?? d.source.developmentReplay?.commits.length;
  const rows = d.source.developmentReplay?.commits ?? d.commits ?? [];
  const mappings = [...(d.developmentMappings ?? []), ...(d.commitMappings ?? [])];
  const internal =
    d.internalCommitCount ??
    (d.candidate && d.commitPolicy?.strategy === 'rewrite'
      ? new Set(mappings.map((m) => m.internal)).size
      : null);
  const oldSquash = !version && development > 1 && d.commits?.length === 1 && !d.source.developmentReplay;
  return `<section class="delivery-overview" aria-label="本笔同步内容" data-delivery-overview>
    <h3>本笔同步内容</h3><div class="delivery-links">${link(d.source.url, d.source.number ? `上游 PR #${d.source.number} ↗` : '上游来源 ↗')}${d.prUrl ? link(d.prUrl, '本笔内部 PR ↗') : '<span>内部 PR 待创建 / 回读确认</span>'}</div>
    <dl class="delivery-metrics"><div><dt>PR 开发提交</dt><dd>${version ? '不重放' : d.source.kind === 'commit' ? '无上游 PR' : (development ?? '未记录')}</dd></div><div><dt>${version ? '上游范围提交' : 'main 落地提交'}</dt><dd>${d.commits?.length ?? '未记录'}</dd></div><div><dt>内部候选提交</dt><dd>${internal ?? (d.candidate ? '未记录' : '待生成')}</dd></div><div><dt>关联 Issue</dt><dd>${d.issues?.length ?? 0}</dd></div></dl>
    ${d.source.developmentReplay ? `<p class="delivery-note">已展开上游 squash：${development} 条 PR 开发提交 → 内部逐条重放；main 的 ${d.commits.length} 条落点单独记录接受对应。</p>` : oldSquash ? '<p class="record-gap">此候选沿用上游压缩后的 main 历史，未展开原 PR 开发提交。需要逐条重放时，先放弃未合入的旧 PR，再重新同步。</p>' : ''}
    ${d.supersedes ? `<p>本笔替代已撤销同步 <code>${esc(d.supersedes)}</code>；旧 PR 和历史保留。</p>` : ''}
    ${issueReferenceNotes(d.source)}
    <div class="delivery-objects"><details class="delivery-object-details" data-persist-details="issues"><summary><span class="delivery-object-title">关联 Issue · ${d.issues?.length ?? 0} 个</span><small>${issueGuide(d.issues?.length ?? 0, version)}</small></summary><p class="delivery-object-guide">展开后查看外部 Issue、内部映射、关联关系和合入后的关单条件。</p>${rowsForIssues(d, snapshot, historical, version)}</details>
    <details class="delivery-object-details" data-persist-details="commits"><summary><span class="delivery-object-title">${d.source.developmentReplay ? '逐条开发提交与内部 SHA' : '本笔提交与内部 SHA'} · ${rows.length} 条</span><small>${rows.length ? '展开后查看外部 SHA、内部 SHA 和提交标题。' : '提交清单尚未冻结。'}</small></summary><p class="delivery-object-guide">这里是业务对象映射；底层命令和重试记录请查看对应阶段的执行详情。</p>${rowsForCommits(d, rows, mappings)}</details></div>
    <details class="delivery-more" data-persist-details="source-actions"><summary>更多来源与操作</summary>${d.source.number ? link(`${d.source.url}/commits`, '查看上游 PR 的完整开发提交 ↗') : ''}
    ${!historical && d.source.number && development === undefined ? '<button type="button" data-action="inspect-delivery-source">读取原 PR 开发提交数量与清单</button>' : ''}
    ${cancellationForm(d, historical)}</details></section>`;
}

function issueRow(issue, snapshot, d, historical) {
  const mapping =
    d.issueMappings?.[issue.sourceId] ?? (!historical ? snapshot.state?.issues?.[issue.sourceId] : null);
  const result = d.issueResults?.[issue.sourceId];
  return `<li><b>${link(issue.url, `#${issue.number} ${issue.title ?? '标题未记录'}`)}</b><details class="tech"><summary>为什么？</summary><div class="tech-copy">${issue.relation === 'closes' ? '上游有 PR 关闭事件：内部 PR 合入核验后关闭' : '上游仅引用 / 关联，保持内部 Issue 打开；如需随 PR 关闭，请在上游使用 closes、fixes 或 resolves'} · ${mapping ? link(mapping.url, `内部 #${mapping.internalId}`) : '内部 Issue 待创建 / 未记录'}${result ? ` · ${esc(result.state)}` : ''}</div></details></li>`;
}
function rowsForIssues(d, snapshot, historical, version) {
  const rows = (d.issues ?? []).map((issue) => issueRow(issue, snapshot, d, historical));
  return rows.length
    ? `<ul class="delivery-object-list">${rows.join('')}</ul>`
    : `<p>${version ? '版本模式不搬运 Issue。' : '本笔未关联 Issue。'}</p>`;
}
function rowsForCommits(d, rows, mappings) {
  if (!rows.length) return '<p>尚未冻结提交清单。</p>';
  return `<ul class="delivery-object-list">${rows
    .map((source) => {
      const detail = d.commitDetails?.find((item) => item.sha === source);
      const mapped = mappings.find((item) => item.source === source);
      return `<li><b>${esc(detail?.subject ?? '提交标题未记录')}</b><p>外部 ${shortSha(source)}<br>内部 ${mapped ? shortSha(mapped.internal) : d.commitPolicy?.strategy === 'rewrite' ? '待重写 / 未记录' : shortSha(source)}</p></li>`;
    })
    .join('')}</ul>`;
}
function issueGuide(count, version) {
  if (version) return '版本模式不搬运 Issue。';
  return count ? '展开查看外部 → 内部映射与关单条件。' : '本笔没有关联 Issue；展开查看原因。';
}
function link(url, text) {
  return /^https?:\/\//.test(url ?? '')
    ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`
    : esc(text);
}
function cancellationForm(d, historical) {
  if (historical || d.acceptedInternal || ['COMPLETE', 'CANCELLED'].includes(d.status)) return '';
  return `<details class="delivery-cancel" ${d.cancellation?.status === 'REQUESTED' ? 'open' : ''}><summary>放弃本笔并重新同步</summary><p>关闭未合入的旧 PR，保留 Issue、候选分支和历史，接受基线不变。本轮会暂停；明确继续后重新读取原目标并创建新 PR，不会强推旧分支或回退 main。</p><form id="cancel-delivery-form" data-form="cancel-delivery" data-edit-baseline="${esc(JSON.stringify([d.id, d.prUrl, d.candidate, d.status, d.cancellation?.requestedAt]))}"><input type="hidden" name="deliveryId" value="${esc(d.id)}"><input type="hidden" name="previousUrl" value="${esc(d.prUrl ?? '')}"><label><input type="checkbox" name="confirmed" required>我确认关闭旧 PR，并保留原 Issue 与历史</label><small>勾选仅保留在本页；刷新或 PR 变化后需要重新确认。</small><button type="submit">${d.cancellation?.status === 'REQUESTED' ? '回读并完成原 PR 撤销' : '关闭旧 PR 并撤销本笔'}</button></form></details>`;
}

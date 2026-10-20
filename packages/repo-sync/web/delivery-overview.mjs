import { issueReferenceNotes } from './issue-reference-notes.mjs';
import { esc, shortSha, title } from './ui.mjs';
import { candidateRecovery } from './candidate-recovery.mjs';

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
    <div class="v3-dov-head"><div><p class="v3-eyebrow">本笔交付</p><h3>${esc(title(d))}</h3></div><div class="delivery-links"><span class="v3-link"><small>上游</small>${link(d.source.url, d.source.number ? `PR #${d.source.number} ↗` : '来源 ↗')}</span><span class="v3-link ${d.prUrl ? '' : 'is-pending'}"><small>内部</small>${d.prUrl ? link(d.prUrl, '内部 PR ↗') : '<span>待创建 / 回读确认</span>'}</span></div></div>
    <dl class="delivery-metrics"><div><dt>PR 开发提交</dt><dd>${version ? '不重放' : d.source.kind === 'commit' ? '无上游 PR' : (development ?? '未记录')}</dd></div><div><dt>${version ? '上游范围提交' : 'main 落地提交'}</dt><dd>${d.commits?.length ?? '未记录'}</dd></div><div><dt>内部候选提交</dt><dd>${internal ?? (d.candidate ? '未记录' : '待生成')}</dd></div><div><dt>关联 Issue</dt><dd>${d.issues?.length ?? 0}</dd></div></dl>
    ${d.issues?.length ? `<p class="issue-brief">冻结 Issue：${d.issues.map((issue) => link(issue.url, `#${issue.number} ${issue.title ?? ''}`)).join(' · ')}</p>` : ''}
    ${d.source.developmentReplay ? `<p class="delivery-note">已展开上游 squash：${development} 条 PR 开发提交 → 内部逐条重放；main 的 ${d.commits.length} 条落点单独记录接受对应。</p>` : oldSquash ? '<p class="record-gap">此候选沿用上游压缩后的 main 历史，未展开原 PR 开发提交。需要逐条重放时，先放弃未合入的旧 PR，再重新同步。</p>' : ''}
    ${d.supersedes ? `<p>本笔替代已撤销同步 <code>${esc(d.supersedes)}</code>；旧 PR 和历史保留。</p>` : ''}
    ${issueReferenceNotes(d.source)}
    <div class="delivery-objects"><details class="delivery-object-details" data-persist-details="issues"><summary><span class="delivery-object-title">关联 Issue · ${d.issues?.length ?? 0} 个</span><small>${issueGuide(d.issues?.length ?? 0, version)}</small></summary><p class="delivery-object-guide">展开后查看外部 Issue、内部映射、关联关系和合入后的关单条件。</p>${rowsForIssues(d, snapshot, historical, version)}</details>
    <details class="delivery-object-details" data-persist-details="commits"><summary><span class="delivery-object-title">${d.source.developmentReplay ? '逐条开发提交与内部 SHA' : '本笔提交与内部 SHA'} · ${rows.length} 条</span><small>${rows.length ? '展开后查看外部 SHA、内部 SHA 和提交标题。' : '提交清单尚未冻结。'}</small></summary><p class="delivery-object-guide">这里是业务对象映射；底层命令和重试记录请查看对应阶段的执行详情。</p>${rowsForCommits(d, rows, mappings)}</details></div>
    <details class="delivery-more" data-persist-details="source-actions"><summary>来源追溯与撤销</summary>${d.source.number ? link(`${d.source.url}/commits`, '查看上游 PR 的完整开发提交 ↗') : ''}
    ${!historical && d.source.number && development === undefined ? '<button type="button" data-action="inspect-delivery-source">读取原 PR 开发提交数量与清单</button>' : ''}
    </details>${candidateRecovery(d, historical)}</section>`;
}

function issueRow(issue, snapshot, d, historical) {
  const mapping =
    d.issueMappings?.[issue.sourceId] ?? (!historical ? snapshot.state?.issues?.[issue.sourceId] : null);
  const result = d.issueResults?.[issue.sourceId];
  return `<li><b>${link(issue.url, `#${issue.number} ${issue.title ?? '标题未记录'}`)}</b><p class="note-line">${issue.relation === 'closes' ? '上游有 PR 关闭事件：内部 PR 合入核验后关闭' : '上游仅引用 / 关联，保持内部 Issue 打开；如需随 PR 关闭，请在上游使用 closes、fixes 或 resolves'} · ${mapping ? link(mapping.url, `内部 #${mapping.internalId}`) : '内部 Issue 待创建 / 未记录'}${result ? ` · ${esc(result.state)}` : ''}</p></li>`;
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

import { esc, sha, shortSha, when } from './ui.mjs';
import { versionPreview } from './version.mjs';
export function facts(stage, d, record, historical, snapshot) {
  return [null, scopeFacts, preparationFacts, prFacts, approvalFacts, resultFacts][stage](
    d,
    record,
    historical,
    snapshot,
  );
}
function scopeFacts(d, record, historical, snapshot) {
  return `<p>来源 ${d.source.url ? `<a href="${esc(d.source.url)}" target="_blank" rel="noopener">${esc(d.source.title)}</a>` : esc(d.source.title)}<br>上游 tag：${esc(d.source.tag ?? d.syncTarget?.frozenTag?.name ?? '不适用')} · 内部 tag：未记录（工具未创建内部 tag）${d.syncTarget ? `<br>本轮终点：${esc(d.syncTarget.value)} · ${shortSha(d.syncTarget.commit)}` : ''}<br>候选分支 ${esc(d.branch)} → ${esc(record?.configurations.at(-1)?.snapshot.targetBranch ?? (historical ? '未记录' : snapshot.config.targetBranch))}</p>${configurationFacts(record, historical, snapshot)}<details><summary>${d.mode === 'version' ? '上游版本提交范围（不重放提交）' : '本笔原始 commit 对应'}</summary>${d.commits.map((commit) => `<p class="note-line">${shortSha(commit)}${d.mode === 'version' ? '' : ` → ${shortSha(d.commitMappings?.find((item) => item.source === commit)?.internal ?? commit)}`}</p>`).join('')}<p class="note-line">${d.mode === 'version' ? '内部以一次内容更新提交接收版本，来源 SHA 用于追溯。' : d.commitPolicy?.strategy === 'rewrite' ? `按冻结内部身份 ${esc(d.commitPolicy.identity.name)} &lt;${esc(d.commitPolicy.identity.email)}&gt; 重写作者和提交者；内外 SHA 映射已保存。声明路径保留内部，其余核心严格一致。` : '保留来源原始 Git 对象与消息；必要接收节点使用配置的内部身份。其余核心路径严格一致。'}</p></details>`;
}
function preparationFacts(d, record, historical, _snapshot) {
  return `${d.preview ? versionPreview(d, esc, sha) : ''}<p>候选 ${shortSha(d.candidate ?? '尚未构造')}<br>检查配置 ${esc(d.checks?.profile ?? '尚无检查结果')} · 已检查 head ${shortSha(d.checks?.head ?? '尚无检查结果')}</p>${
    historical
      ? `<details><summary>本笔 Issue 映射与旧版处理记录</summary>${(record?.issues ?? []).map((issue) => `<p>${esc(issue.sourceId)} → ${esc(issue.mapping?.internalId ?? '未记录')}${issue.mapping?.url ? ` · <a href="${esc(issue.mapping.url)}" target="_blank" rel="noopener">内部 Issue ↗</a>` : ''}</p>`).join('') || '<p>版本模式无 Issue 搬运。</p>'}${Object.entries(
          d.resolutions ?? {},
        )
          .map(([path, value]) => `<p>${esc(path)} · ${esc(value.choice)}（内容保留在本机，不在记录列表展开）</p>`)
          .join('')}</details>`
      : ''
  }`;
}
function prFacts(d, _record, historical, _snapshot) {
  return `<p>候选 ${shortSha(d.candidate ?? '尚未发布')}<br>PR 引用来源：${esc({ 'git-receipt': 'Git 回执与 ref 核验', adapter: '平台接口回读', operator: '操作者登记' }[d.prReference?.verifiedBy] ?? '尚未登记')}</p>${historical && d.prUrl ? `<a class="button" href="${esc(d.prUrl)}" target="_blank" rel="noopener">查看对应内部 PR ↗</a>` : ''}`;
}
function resultFacts(d, record) {
  return `<p>外部 ${shortSha(d.target)} → 内部 ${shortSha(d.acceptedInternal ?? '待接受')}<br>上游 tag ${esc(d.source.tag ?? d.syncTarget?.frozenTag?.name ?? '不适用')} · 内部 tag 未记录</p>${(record?.issues ?? []).map((issue) => `<p class="note-line">${esc(issue.sourceId)} · 接收状态 ${esc(issue.result?.state ?? '未记录')} · 来源 ${esc(issue.result?.confirmedBy === 'platform' ? '平台回读' : issue.result?.confirmedBy === 'operator' ? '人工登记' : '未记录')}</p>`).join('')}<details><summary>本笔业务事件</summary>${record?.events.map((event) => `<p>${when(event.time)} · ${esc(event.message)}</p>`).join('') || '<p>尚无事件。</p>'}</details>`;
}
function approvalFacts(d, _record, _historical, _snapshot) {
  return `<p>${d.acceptedInternal ? `已核验内部合入节点 ${shortSha(d.acceptedInternal)}` : '审核与合入在内部平台进行。尚未观察到可接受的 Git 合入结果。'}<br>平台实际审批时间：未记录；以下时间为本工具操作时间。</p>`;
}

function configurationFacts(record, historical) {
  const entries = record?.configurations ?? [];
  if (!entries.length)
    return `<details><summary>当时配置与来源</summary><p>${historical ? '未记录，不能用当前配置替代。' : '配置摘要将在发起和执行时保存。'}</p></details>`;
  return `<details><summary>当时配置与来源</summary>${entries
    .map((entry) => {
      const c = entry.snapshot;
      return `<article><h4>${when(entry.time)} · ${entry.source === 'start' ? '发起时冻结' : entry.source === 'configuration' ? '配置修改' : '执行时观察'}</h4><p>外部 ${esc(c.sourceUrl)} · ${esc(c.sourceBranch)}<br>内部 ${esc(c.internalUrl)} · ${esc(c.targetBranch)}<br>网页 ${esc(c.internalWebUrl ?? '未配置')}<br>模式 ${esc(c.mode)} · PR ${esc(c.prTransport)} · Issue ${esc(c.issueTransport ?? '未记录')}<br>保留路径 ${esc(c.internalPaths?.join('、') || '无')}${c.mergePaths?.length ? `<br>旧版共同文件规则（已停用）：${esc(c.mergePaths.join('、'))}` : ''}<br>检查 ${esc(c.checkProfile)}（${c.checkCount} 项）；摘要不包含命令与凭据。<br>配置指纹 ${shortSha(c.fingerprint)}</p></article>`;
    })
    .join(
      '',
    )}${!historical && record.currentConfiguration && entries.at(-1).snapshot.fingerprint !== record.currentConfiguration.fingerprint ? `<p class="bad">当前配置与上次记录不同；下一次执行会记录实际使用的配置。</p>` : ''}</details>`;
}

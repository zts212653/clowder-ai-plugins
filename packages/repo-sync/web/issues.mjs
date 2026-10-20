export function issueForms(active, state, esc) {
  return active.issues
    .map((issue) => {
      const mapping = state.issues[issue.sourceId];
      const editable = !mapping || (!mapping.receipts.length && !active.candidate);
      const form = `<form data-form="issue" data-source="${esc(issue.sourceId)}"><input name="deliveryId" type="hidden" value="${esc(active.id)}"><input name="previousId" type="hidden" value="${esc(mapping?.internalId ?? '')}"><input name="previousUrl" type="hidden" value="${esc(mapping?.url ?? '')}"><label>内部 Issue 编号<input name="internalId" required value="${esc(mapping?.internalId ?? '')}"></label><label>内部 Issue 具体链接<input name="url" type="url" required value="${esc(mapping?.url ?? '')}"></label><button type="submit">${mapping ? '纠正此 Issue 映射' : '保存此 Issue 映射'}</button></form>`;
      return `<div class="card"><h3><a href="${esc(issue.url)}" target="_blank" rel="noopener">来源 Issue #${issue.number} ↗</a> · ${esc(issue.title)}</h3><p>Issue 需在内部平台创建或复用；此处记录对应关系，不由 Git 建单。</p>${mapping ? `<p>内部 #${esc(mapping.internalId)} · <a href="${esc(mapping.url)}" target="_blank" rel="noopener">打开内部 Issue ↗</a></p>${editable ? `<details><summary>编号或链接填错了？纠正未使用的映射</summary>${form}</details>` : '<p>映射已随候选冻结或已有接收记录，不能改写。</p>'}` : `<details><summary>复制 Issue 来源正文</summary><pre class="bounded-text">${esc(`来源：${issue.url}\n\n${issue.body ?? ''}`)}</pre></details>${form}`}</div>`;
    })
    .join('');
}

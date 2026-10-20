export function commitFields(config, esc) {
  const identity = config?.receivingIdentity ?? { name: 'Repository Sync', email: 'repo-sync@localhost' };
  return `<fieldset><legend>内部提交身份</legend><label>提交处理方式<select name="commitStrategy"><option value="preserve" ${config?.commitStrategy !== 'rewrite' ? 'selected' : ''}>保留上游作者和原始 SHA</option><option value="rewrite" ${config?.commitStrategy === 'rewrite' ? 'selected' : ''}>按统一内部身份重写，记录内外 SHA 映射</option></select></label><details data-identity-details ${config?.commitStrategy === 'rewrite' ? 'open' : ''}><summary>姓名与邮箱（重写模式必填；保留模式用于接收节点）</summary><div class="split"><label>内部 Git 姓名<input name="commitName" required value="${esc(identity.name)}"></label><label>内部 Git 邮箱<input name="commitEmail" type="email" required value="${esc(identity.email)}"></label></div></details><details class="tech"><summary>说明</summary><div class="tech-copy">过程模式重写保留每条开发提交、消息与日期并记录内外 SHA；上游 squash PR 会核验原 PR 完整历史后展开，末端核心范围必须等于 main 落点。按版本更新仍为一个内容提交。Git 凭据决定推送账号，API Token 决定平台操作者，均不代替署名。</div></details></fieldset>`;
}
export function identitySettings(snapshot, esc) {
  if (!snapshot.config || !snapshot.state || !snapshot.connection) return '';
  const active = snapshot.state.active;
  return `<details class="card"><summary>提交身份策略</summary>${active ? '<p>存在未完成交付，身份策略已冻结。完成原交付后可修改下一轮策略。</p>' : `<form data-form="configure-identity"><input type="hidden" name="expectedRevision" value="${esc(snapshot.connection.revision)}">${commitFields(snapshot.config, esc)}<button type="submit">保存后续同步的提交身份</button></form>`}</details>`;
}

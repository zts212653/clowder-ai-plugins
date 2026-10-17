export function closureSettings(snapshot, esc) {
  if (!snapshot.connection || snapshot.config?.mode !== 'continuous' || snapshot.config.commitClosureVerified)
    return '';
  return `<section id="closure-settings"><h3>首次同步 · 确认提交消息不会关错 Issue</h3><p>外部提交里可能写着 <code>Closes #123</code>。搬到内部后，平台可能把它理解为关闭<b>内部 #123</b>，而对应的内部 Issue 实际是另一个编号。同步流程会按映射在合入核验后关单，但无法替平台禁止提交消息触发的关单。</p><details><summary>如何确认？查看一次性的测试步骤</summary><ol><li>使用独立的临时测试仓库，创建测试 Issue，记下编号 N。不要使用正式仓库的 Issue。</li><li>在新分支提交一条消息 <code>Closes #N</code>（把 N 换成测试编号），推送后检查该测试 Issue 是否仍为打开。</li><li>通过测试 PR 合入后再检查一次：若 Issue 被自动关闭，请管理员禁用接收仓库的提交消息关单规则；关闭规则后重新验证。</li><li>推送和合入后均未自动关单，或管理员已确认并验证禁用了该规则，才保存下面的确认。</li></ol><p>这与 Git 凭据、代码检查无关。按 tag 更新不搬运原始提交消息，不需要此项确认。</p></details><form data-form="configure-closure"><input type="hidden" name="expectedRevision" value="${esc(snapshot.connection.revision)}"><label><input type="checkbox" name="confirmed" required>已确认：内部平台不会根据搬入的提交消息自动关闭 Issue</label><button type="submit">保存关单规则确认，继续本笔同步</button></form><p>只记录此仓库的确认，不修改基线、候选或平台 Issue。未确认前仍可配置仓库、核验基线和查看交付，候选发布会暂停。</p></section>`;
}

export function closureInstructions() {
  return '<p>外部消息 <code>Closes #123</code> 原本指向外部 Issue。内部编号不同，平台可能误关内部同号 Issue；本工具另按映射在合入核验后关单。</p><ol><li>在独立测试仓创建一个测试 Issue，记下编号 N。</li><li>新分支提交消息 <code>Closes #N</code>，推送后检查测试 Issue 是否仍打开。</li><li>通过测试 PR 合入，再检查一次；若自动关单，请管理员按该平台的仓库设置禁用提交消息关单规则，再重新验证。</li><li>记录测试时间与结论。推送及合入都不会自动关单后，再确认本接收条件。平台设置入口不同，工具不会替你修改平台规则。</li></ol><p>不要使用正式 Issue 做此测试；按版本更新不搬运原消息，无需此条件。</p>';
}

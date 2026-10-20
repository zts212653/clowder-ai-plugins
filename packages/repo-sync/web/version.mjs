import { fileRuleFields } from './file-rule-fields.mjs';
import { fileTree } from './files.mjs';
import { title } from './ui.mjs';
export function modeSettings(config, state, esc) {
  const version = config.mode === 'version';
  const rules = fileRuleFields(config.internalPaths);
  return `<section class="card"><h2>1 · 选择同步方式</h2>${state ? `<span class="badge">${version ? '按版本更新' : '同步开发过程'}</span><p class="note-line">${version ? '按 tag 接收版本内容，保留内部差异，只创建一个内部同步 PR。' : '按 main 的实际落地 PR 逐笔同步 Issue 与原始对象；保留声明的内部路径，其余核心范围严格一致。'}</p>${lockedRules(config, esc)}<small>已启用绑定的模式与规则已固定。另一种模式请点击上方“新增项目”，独立配置与台账会自动隔离。</small>` : `<form data-form="configure"><label for="sync-mode">同步模式</label><select id="sync-mode" name="mode"><option value="continuous" ${!version ? 'selected' : ''}>同步开发过程 · 搬运 Issue / PR</option><option value="version" ${version ? 'selected' : ''}>按版本更新 · 保留内部差异</option></select><p>两种模式使用相同的文件规则：完整保留内部路径，其余核心文件严格跟随外部。</p><div data-policy><h3>2 · 声明内部差异</h3>${rules}<p>目录以 / 结尾。内部保留规则保留整个文件，包含上游同名文件的变更也会跳过。其余路径必须与基线一致。</p></div><button class="primary" type="submit">保存同步方式与规则</button></form>`}</section>`;
}
export function tagSelector(tags, esc, sha, automatic = false, accepted = null) {
  return `<section class="card task tag-selection"><span class="badge">按版本更新 · 一个同步 PR</span><h2>选择要接收的上游版本</h2><details class="tech"><summary>说明</summary><div class="tech-copy">内部定制文件按已声明规则保留。不会搬运上游 Issue 或逐个创建上游 PR。发布 tag 可以位于独立发布分支，但须包含上次接收版本；按 commit 历史判断前进关系，不按版本名称猜测。</div></details><button data-action="tags" type="button">读取可用 tag</button>${tags.length ? `<form data-accepted-upstream="${esc(accepted ?? '')}" data-form="${automatic ? 'synchronize' : 'select-tag'}"><label for="release-target-tag">目标 tag</label><select id="release-target-tag" name="tag" aria-describedby="release-tag-help">${tags.map((tag) => `<option value="${esc(tag.name)}" data-commit="${esc(tag.commit)}">${esc(tag.name)} · ${esc(tag.commit.slice(0, 12))}</option>`).join('')}</select><small id="release-tag-help">${tags.length} 个标签，已按名称排序。选择后先核验标签、历史和内部差异，再发起同步；不会直接修改内部 main。</small><div class="task-actions"><button class="primary" type="submit">${automatic ? '同步到所选版本 →' : '核对内部差异并选择这个版本 →'}</button><button type="button" data-preview-sync>预览同步范围（只读）</button></div></form><details><summary>查看标签与准确 commit 对应</summary>${tags.map((tag) => `<p>${esc(tag.name)} → ${sha(tag.commit)}</p>`).join('')}</details>` : '<p>先读取标签，再选择目标版本。</p>'}</section>`;
}
export function versionPreview(delivery, esc, sha) {
  return `<section class="card"><h3>${delivery.mode === 'version' ? '本次版本接收范围' : '本笔文件范围'} · ${esc(title(delivery))}</h3><p>来源 ${sha(delivery.base.upstream)} → ${sha(delivery.target)}</p><p>冻结内部基线 ${sha(delivery.base.internal)}</p>${fileTree(delivery.preview.changes, '上游文件变化')}${fileTree(delivery.preview.internalChanges, '内部差异')}</section>`;
}
function lockedRules(config, esc) {
  return `<p>内部保留：${esc((config.internalPaths ?? []).join('、') || '无')}</p>`;
}

export function updateTagChoice(form) {
  if (!form?.hasAttribute('data-accepted-upstream')) return;
  const select = form.elements.namedItem('tag'), button = form.querySelector('[type="submit"]');
  const same = select.selectedOptions[0]?.dataset.commit === form.dataset.acceptedUpstream;
  const preview = form.querySelector('[data-preview-sync]');
  if (preview) {
    preview.disabled = same; preview.toggleAttribute('data-preserve-disabled', same);
    preview.title = same ? '该版本已接收，请在历史记录查看核验结果' : '';
  }
  button.disabled = same;
  button.toggleAttribute('data-preserve-disabled', same);
  button.textContent = same ? '此版本已接收，无需再次同步' :
    form.dataset.form === 'synchronize' ? '同步到所选版本 →' : '核对内部差异并选择这个版本 →';
}
globalThis.document?.addEventListener('change', (event) => {
  if (event.target.name === 'tag') updateTagChoice(event.target.form);
});

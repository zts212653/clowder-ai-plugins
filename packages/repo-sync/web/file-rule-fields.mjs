import { parseRules } from './file-rule-selection.mjs';
import { esc } from './ui.mjs';

export function ruleList(rules) {
  return rules.length
    ? `<ul class="rule-chips">${rules.map((path) => `<li><code>${esc(path)}</code><button type="button" data-remove-rule="${esc(path)}" aria-label="取消保留 ${esc(path)}">×</button></li>`).join('')}</ul>`
    : '<p>尚未选择内部保留路径。</p>';
}
export function fileRuleFields(paths = []) {
  return `<section data-rule-fields><h3>内部保留范围</h3><p>基线核验发现差异后，可直接在文件树勾选文件或目录。保留内部表示跳过这些路径的外部更新，其余核心文件仍须严格一致。</p><div data-config-rule-list>${ruleList(paths)}</div><details class="rule-manual"><summary>手动填写路径（高级）</summary><label>内部保留文件 / 目录（每行一项）<textarea name="internalPaths" rows="3" placeholder="internal-docs/&#10;README.internal.md">${esc(paths.join('\n'))}</textarea></label><small>目录以 / 结尾，不支持通配符。目录规则包含所有文件及后续新增文件。</small></details></section>`;
}
export function ruleField() {
  return document.querySelector(
    'form[data-form="configure-repositories"] [name="internalPaths"], form[data-form="configure"] [name="internalPaths"]',
  );
}
export function hydrateRuleLists() {
  for (const section of document.querySelectorAll('[data-rule-fields]')) {
    const field = section.querySelector('[name="internalPaths"]');
    section.querySelector('[data-config-rule-list]').innerHTML = ruleList(parseRules(field.value));
  }
}

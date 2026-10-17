import { ruleField } from './file-rule-fields.mjs';
import { parseRules, ruleState, savedRules, selectableRule, toggleRule } from './file-rule-selection.mjs';

const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const labels = {
  unchanged: '内容相同',
  added: '新增',
  deleted: '删除',
  modified: '修改',
  conflict: '冲突',
  internal: '内部保留',
  merge: '历史旧规则（已停用）',
  upstream: '跟随上游',
};
const state = new WeakMap();
export function fileTree(items, title, { rules = false } = {}) {
  return `<details class="file-list" ${rules ? 'open' : ''}><summary>${escapeHtml(title)}（${items.length}）</summary><div data-file-tree data-items="${escapeHtml(JSON.stringify(items))}" data-rules="${Boolean(rules)}"><div class="file-tools"><label>搜索文件<input type="search" data-file-search placeholder="输入完整路径或文件名"></label><label>处理范围<select data-file-filter><option value="all">全部</option><option value="readme">查找 README</option><option value="documentation">查找文档</option><option value="blocking">未处理 / 阻塞</option><option value="internal">内部保留</option><option value="upstream">跟随上游</option></select></label></div><div data-tree-body class="file-tree"></div><div class="file-pages"><button type="button" data-tree-page="-1">上一页</button><span data-tree-count></span><button type="button" data-tree-page="1">下一页</button></div><small>每页最多 50 个文件；搜索覆盖完整清单。${rules ? '选择目录会保留整个目录，包括未显示和后续新增的文件。' : ''}</small></div></details>`;
}
function choice(path, rules) {
  const value = ruleState(rules, path);
  const supported = selectableRule(path);
  return `<label class="file-choice"><input type="checkbox" data-rule-choice="${escapeHtml(path)}" ${value.checked ? 'checked' : ''} ${value.inherited || !supported ? 'disabled data-preserve-disabled' : ''} ${value.partial ? 'data-partial' : ''} aria-label="保留内部 ${escapeHtml(path)}"><span>${path.endsWith('/') ? `保留整个目录 ${escapeHtml(path)}` : '保留内部'}${value.inherited ? `（由 ${escapeHtml(value.inherited)} 覆盖；先取消目录才能单选）` : !supported ? '（特殊路径不支持逐项选择，请选合法父目录或先规范文件名）' : ''}</span></label>`;
}
function row(item, rules, name, saved) {
  const blockage = item.kind === 'conflict' ? '× 冲突待解决' : '× 未声明差异';
  const action = rules ? choice(item.path, rules) : '';
  const treatment =
    rules && ruleState(rules, item.path).checked
      ? saved && ruleState(saved, item.path).checked ? '内部保留 · 已保存' : '内部保留修改 · 尚未保存'
      : item.blocking
        ? blockage
        : escapeHtml(labels[item.category] ?? '');
  return `<li class="file-row"><span title="${escapeHtml(item.path)}">${escapeHtml(name)}</span><small class="${item.blocking && !(rules && ruleState(rules, item.path).checked) ? 'bad' : ''}">${escapeHtml(labels[item.kind] ?? item.kind)} · ${treatment}${item.sourceMode && item.internalMode && item.sourceMode !== item.internalMode ? ' · 文件类型/权限变化' : ''}</small>${action}${rules ? `<button type="button" data-view-file="${escapeHtml(item.path)}">查看两侧内容</button>` : ''}</li>`;
}
function nodes(items, rules, searching, all, saved, prefix = '', depth = 0) {
  const files = [];
  const dirs = new Map();
  for (const item of items) {
    const parts = item.display.split('/');
    if (parts.length === 1 || depth >= 12) files.push(row(item, rules, item.display, saved));
    else {
      const name = parts.shift();
      if (!dirs.has(name)) dirs.set(name, []);
      dirs.get(name).push({ ...item, display: parts.join('/') });
    }
  }
  const folders = [...dirs.entries()].map(
    ([name, list]) =>
      `<li class="file-directory"><div class="directory-line">${rules ? choice(`${prefix}${name}/`, rules) : ''}<details data-tree-directory="${escapeHtml(`${prefix}${name}/`)}" ${searching || rules ? 'open' : ''}><summary>📁 ${escapeHtml(name)}/ · ${all.filter((item) => item.path.startsWith(`${prefix}${name}/`)).length} 个差异文件</summary>${nodes(list, rules, searching, all, saved, `${prefix}${name}/`, depth + 1)}</details></div></li>`,
  );
  return `<ul>${folders.join('')}${files.join('')}</ul>`;
}
function render(root) {
  const current = state.get(root);
  const focused = root.contains(document.activeElement) ? document.activeElement.dataset.ruleChoice : null;
  const collapsed = new Set(
    [...root.querySelectorAll('[data-tree-directory]:not([open])')].map((node) => node.dataset.treeDirectory),
  );
  const query = root.querySelector('[data-file-search]').value.toLocaleLowerCase();
  const filter = root.querySelector('[data-file-filter]').value;
  const rules = root.dataset.rules === 'true' ? parseRules(ruleField()?.value ?? '') : null;
  const items = current.items.filter(
    (item) =>
      item.path.toLocaleLowerCase().includes(query) &&
      (filter === 'all' ||
        (filter === 'readme'
          ? /(^|\/)readme(?:\.|$)/i.test(item.path)
          : filter === 'documentation'
            ? /(^|\/)(docs?|documentation)\/|\.(md|mdx|rst|adoc|txt)$/i.test(item.path)
            : filter === 'blocking'
              ? item.blocking && !ruleState(rules ?? [], item.path).checked
              : filter === 'internal' && rules
                ? ruleState(rules, item.path).checked
                : item.category === filter)),
  );
  const pages = Math.max(1, Math.ceil(items.length / 50));
  current.page = Math.min(pages - 1, Math.max(0, current.page));
  const visible = items
    .slice(current.page * 50, (current.page + 1) * 50)
    .map((item) => ({ ...item, display: item.path }));
  root.querySelector('[data-tree-body]').innerHTML = visible.length
    ? nodes(visible, rules, Boolean(query), current.items, savedRules(root.closest('[data-saved-rules]')))
    : '<p>没有符合条件的文件。</p>';
  for (const checkbox of root.querySelectorAll('[data-partial]')) checkbox.indeterminate = true;
  for (const node of root.querySelectorAll('[data-tree-directory]'))
    if (current.query === query && collapsed.has(node.dataset.treeDirectory)) node.open = false;
  current.query = query;
  if (focused) {
    const target = [...root.querySelectorAll('[data-rule-choice]')].find((node) => node.dataset.ruleChoice === focused);
    if (!target?.disabled) target?.focus({ preventScroll: true });
  }
  root.querySelector('[data-tree-count]').textContent =
    `${items.length} 个匹配文件 · 第 ${current.page + 1} / ${pages} 页`;
  for (const button of root.querySelectorAll('[data-tree-page]'))
    button.disabled = Number(button.dataset.treePage) < 0 ? current.page === 0 : current.page === pages - 1;
}
export function hydrateFiles(container = document) {
  for (const root of container.querySelectorAll('[data-file-tree]')) {
    if (!state.has(root)) state.set(root, { items: JSON.parse(root.dataset.items), page: 0 });
    render(root);
  }
}
globalThis.document?.addEventListener('input', (event) => {
  if (!event.target.matches('[data-file-search]')) return;
  const root = event.target.closest('[data-file-tree]');
  state.get(root).page = 0;
  render(root);
});
globalThis.document?.addEventListener('change', (event) => {
  if (event.target.matches('[data-rule-choice]')) {
    const field = ruleField();
    if (!field || event.target.disabled) return;
    field.value = toggleRule(parseRules(field.value), event.target.dataset.ruleChoice, event.target.checked).join('\n');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  if (!event.target.matches('[data-file-filter]')) return;
  const root = event.target.closest('[data-file-tree]');
  state.get(root).page = 0;
  render(root);
});
globalThis.document?.addEventListener('click', (event) => {
  const file = event.target.closest('[data-view-file]');
  if (file) {
    const panel = file.closest('#baseline-differences');
    panel.querySelector('[data-baseline-path]').value = file.dataset.viewFile;
    panel.querySelector('[data-baseline-path]').dispatchEvent(new Event('change', { bubbles: true }));
    panel.querySelector('[data-baseline-read]').click();
    return;
  }
  const button = event.target.closest('[data-tree-page]');
  if (!button) return;
  const root = button.closest('[data-file-tree]');
  state.get(root).page += Number(button.dataset.treePage);
  render(root);
});

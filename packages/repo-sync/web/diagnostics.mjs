import { fileTree } from './files.mjs';
import { esc } from './ui.mjs';
export function diagnostics(error, snapshot, esc) {
  if (!error?.details?.differences) return '';
  const editable = !snapshot.state && (!snapshot.connection || snapshot.connection.editable);
  return `<section class="card bad" id="baseline-differences" data-saved-rules="${esc(JSON.stringify(snapshot.config?.internalPaths ?? []))}" data-upstream="${esc(error.details.upstream)}" data-internal="${esc(error.details.internal)}"><h3>× 文件差异待处理</h3><p>比较外部已同步版本 U0 <code>${esc(error.details.upstream)}</code> 与内部当前版本 I0 <code>${esc(error.details.internal)}</code>。外部 U0 之后的正常更新不属于这份内部差异。</p><details class="tech"><summary>处理建议</summary><div class="tech-copy">${editable ? '1 · 查看差异并勾选需要保留的内部文件或目录。2 · 确认下面的保留范围。3 · 保存并重新核验。勾选仅是草稿，重新核验通过才会登记基线。' : snapshot.state ? '此绑定已启用，规则不能直接改写。意外修改应通过内部修复 PR 处理；新增定制规则需要新的私有配置与经过核验的基线，原台账保留。若有未完成交付，先恢复原交付。' : '此配置由本地文件管理。请在私有配置修改 internalPaths 后重新核验；未声明保留的核心文件必须一致。'}</div></details><div class="baseline-review-layout"><div class="baseline-selection">${fileTree(error.details.differences, '完整文件差异', { rules: editable })}${editable ? '<section class="rule-review"><h4 data-rule-state>内部保留规则 · 已保存</h4><div data-selected-rules></div><p data-rule-count></p><p>选中的整个文件或目录会跳过外部更新。此操作仅保存文件规则，其他配置草稿不会同时保存。</p><button type="button" class="primary" data-save-file-rules>保存所选规则并重新核验</button><p data-rule-feedback role="status"></p></section>' : '<button type="button" data-view="configuration">核对基线与文件规则</button>'}</div><details class="baseline-viewer"><summary>查看具体文件的两侧内容</summary><label>文件路径<select data-baseline-path>${error.details.differences.map((item) => `<option value="${esc(item.path)}">${esc(item.path)}</option>`).join('')}</select></label><button type="button" data-baseline-read data-saved-rules="${esc(JSON.stringify(snapshot.config?.internalPaths ?? []))}" data-upstream="${esc(error.details.upstream)}" data-internal="${esc(error.details.internal)}">查看两侧文件内容</button><div id="baseline-file-content"></div></details></div><p>核验失败不会登记基线或修改 main；仍有差异时可继续选择，或通过内部 PR 对齐核心文件后重试。</p></section>`;
}
export function baselineContent(result, esc) {
  return `<h4>${esc(result.path)}</h4><div class="split"><details open><summary>外部已同步版本 U0</summary><pre class="bounded-text">${esc(result.upstream.content)}</pre></details><details open><summary>内部当前版本 I0</summary><pre class="bounded-text">${esc(result.internal.content)}</pre></details></div>`;
}

export function createBaselineViewer({ snapshot, action }) {
  let selection,
    pending,
    working = false,
    sequence = 0;
  function scope() {
    const panel = document.querySelector('#baseline-differences'),
      s = snapshot();
    return (
      panel &&
      JSON.stringify([
        new URL(location.href).searchParams.get('project') ?? 'default',
        s?.config?.bindingId,
        s?.connection?.revision,
        panel.dataset.upstream,
        panel.dataset.internal,
      ])
    );
  }
  function readSelection() {
    const key = scope();
    if (!key) return null;
    if (selection?.scope !== key) {
      let path;
      try {
        path = sessionStorage.getItem(`repo-sync-file:${key}`);
      } catch {}
      selection = { scope: key, path: path ?? document.querySelector('[data-baseline-path]').value };
    }
    return selection;
  }
  function render() {
    const s = readSelection(),
      field = document.querySelector('[data-baseline-path]');
    if (!s || !field) return;
    if (![...field.options].some((option) => option.value === s.path)) s.path = field.options[0]?.value;
    field.value = s.path;
    for (const button of document.querySelectorAll('[data-view-file]'))
      button.setAttribute('aria-pressed', String(button.dataset.viewFile === s.path));
    const target = document.getElementById('baseline-file-content');
    if (target)
      target.innerHTML =
        s.content ??
        `<p role="status">已选择 ${esc(s.path)}${s.loading ? '，正在读取两侧内容…' : '，点击读取两侧内容。'}</p>`;
    if (s.open) target?.closest('details').setAttribute('open', '');
  }
  function choose(path) {
    const current = readSelection();
    if (!current) return;
    if (current.path !== path) selection = { scope: current.scope, path, open: true };
    try {
      sessionStorage.setItem(`repo-sync-file:${current.scope}`, path);
    } catch {}
    render();
  }
  async function load() {
    const s = readSelection(),
      panel = document.querySelector('#baseline-differences');
    if (!s || !panel) return;
    pending = {
      scope: s.scope,
      path: s.path,
      upstream: panel.dataset.upstream,
      internal: panel.dataset.internal,
      ticket: ++sequence,
    };
    s.loading = true;
    s.open = true;
    delete s.content;
    render();
    if (working) return;
    working = true;
    try {
      while (pending) {
        const request = pending;
        pending = null;
        if (request.scope !== scope()) continue;
        const result = await action({
          action: 'baseline-file',
          upstream: request.upstream,
          internal: request.internal,
          path: request.path,
        });
        if (request.ticket !== sequence || request.scope !== scope() || selection?.path !== request.path)
          continue;
        selection.loading = false;
        selection.content =
          result?.result?.path === request.path
            ? baselineContent(result.result, esc)
            : '<p role="status">本次未能读取所选文件。请查看当前错误或等待原操作结束后重新读取；未显示其他文件的正文。</p>';
        render();
      }
    } finally {
      working = false;
    }
  }
  document.addEventListener('change', (event) => {
    if (event.target.matches('[data-baseline-path]')) choose(event.target.value);
  });
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-baseline-read]')) void load();
  });
  document.addEventListener(
    'toggle',
    (event) => {
      const detail = event.target;
      if (
        detail.isConnected &&
        detail.querySelector?.('#baseline-file-content') &&
        detail.tagName === 'DETAILS' &&
        selection?.scope === scope()
      )
        selection.open = detail.open;
    },
    true,
  );
  return { render };
}

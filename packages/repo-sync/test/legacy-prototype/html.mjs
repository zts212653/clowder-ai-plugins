export const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
export const sha = (value) =>
  `<button type="button" class="sha" data-copy="${escapeHtml(value)}" title="${escapeHtml(value)}" aria-label="复制提交 ${escapeHtml(value)}">${escapeHtml(String(value ?? '').slice(0, 8))} <span>⧉</span></button>`;
export const internalPrHref = (id) => `/internal/demo/core/pull/${Number(id)}`;

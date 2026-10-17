let sequence = 0;

function clearField(element) {
  const id = element?.dataset.fieldErrorId;
  if (!id) return;
  document.getElementById(id)?.remove();
  const described = (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((item) => item && item !== id);
  if (described.length) element.setAttribute('aria-describedby', described.join(' '));
  else element.removeAttribute('aria-describedby');
  element.removeAttribute('aria-invalid');
  delete element.dataset.fieldErrorId;
}
export function clearFormErrors(form) {
  if (!form) return;
  for (const element of form.querySelectorAll('[data-field-error-id]')) clearField(element);
  form.querySelector('[data-form-errors]')?.remove();
}
export function showFormErrors(kind, fields) {
  if (!kind || !Array.isArray(fields)) return false;
  const form = [...document.querySelectorAll('form[data-form]')].find((item) => item.dataset.form === kind);
  if (!form) return false;
  clearFormErrors(form);
  const marked = fields
    .slice(0, 12)
    .map((item) => markField(form, item))
    .filter(Boolean);
  if (!marked.length) return false;
  const summary = document.createElement('p');
  summary.dataset.formErrors = '';
  summary.className = 'bad form-errors';
  summary.setAttribute('role', 'alert');
  form.prepend(summary);
  updateSummary(form);
  marked[0].focus({ preventScroll: true });
  marked[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
  return true;
}
function markField(form, { field, message }) {
  const control = form.elements.namedItem(field);
  if (!control?.tagName || control.type === 'password' || typeof message !== 'string') return null;
  const error = document.createElement('small');
  error.id = `configuration-error-${++sequence}`;
  error.dataset.fieldError = field;
  error.className = 'bad field-error';
  error.textContent = message;
  control.setAttribute('aria-invalid', 'true');
  control.setAttribute('aria-describedby', `${control.getAttribute('aria-describedby') ?? ''} ${error.id}`.trim());
  control.dataset.fieldErrorId = error.id;
  control.insertAdjacentElement('afterend', error);
  for (let parent = control.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') parent.open = true;
    if (parent.hidden && form.contains(parent)) parent.hidden = false;
  }
  return control;
}
function updateSummary(form) {
  const summary = form.querySelector('[data-form-errors]'),
    count = form.querySelectorAll('[data-field-error-id]').length;
  if (!summary) return;
  if (!count) {
    summary.remove();
    return;
  }
  const token =
    form.querySelector('[name="issueAuthMode"]')?.value === 'session' && form.querySelector('input[type="password"]');
  summary.textContent = `配置未保存，请修改标记的 ${count} 项后重试。${token ? 'Token 尚未提交；未提交值仅在当前页面保留，配置范围变化时需重新输入。' : ''}`;
}
export function clearConfigurationErrors(kind) {
  clearFormErrors([...document.querySelectorAll('form[data-form]')].find((form) => form.dataset.form === kind));
}
export function showConfigurationError(kind, error, panel) {
  const located = showFormErrors(kind, error.details?.fields);
  panel.textContent = located ? '' : error.message;
  panel.hidden = located;
}
export function initializeFormErrors() {
  for (const type of ['input', 'change'])
    document.addEventListener(type, (event) => {
      const form = event.target.closest('form[data-form]');
      if (!form) return;
      clearField(event.target);
      if (event.target.name === 'issueAuthMode') clearField(form.elements.namedItem('issueTokenEnv'));
      updateSummary(form);
    });
}

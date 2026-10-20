// Passwords and action consent survive only this synchronous redraw, never browser storage.
export function retainView(content, binding, revision) {
  if (content.dataset.binding !== (binding ?? 'setup')) return () => {};
  const active = document.activeElement;
  const sameRevision = (content.dataset.revision ?? '') === (revision ?? '');
  const controls = [...content.querySelectorAll('input, select, textarea')];
  const formKey = (element) => {
    const form = element.form;
    return form
      ? JSON.stringify([
          form.dataset.form ?? '',
          form.dataset.source ?? '',
          form.dataset.editBaseline ?? form.elements.namedItem('expectedRevision')?.value ?? '',
          ...['deliveryId', 'previousUrl', 'path', 'runId'].map(
            (name) => form.elements.namedItem(name)?.value ?? '',
          ),
        ])
      : element.closest('.record-list')
        ? 'history-filter'
        : '';
  };
  const focused =
    content.contains(active) && active.name
      ? {
          form: formKey(active),
          name: active.name,
          value: active.value,
          start: active.selectionStart,
          end: active.selectionEnd,
          policy: active.form?.dataset.form === 'configure-continuation',
          renderedValue: [...(active.options ?? [])].find((option) => option.defaultSelected)?.value,
        }
      : null;
  const secrets = controls
    .filter((element) => element.type === 'password' && element.value)
    .map((element) => ({ form: formKey(element), name: element.name, value: element.value }));
  const confirmations = controls
    .filter((e) => e.type === 'checkbox' && (e.name === 'confirmed' || e.dataset.confirmationKey))
    .map((e) => ({ form: formKey(e), name: e.name, key: e.dataset.confirmationKey, checked: e.checked }));
  const scroll = window.scrollY;
  return ({ keepScroll = true } = {}) => {
    const next = [...content.querySelectorAll('input, select, textarea')];
    const find = (saved) =>
      next.find((element) => element.name === saved.name && formKey(element) === saved.form);
    for (const saved of sameRevision ? confirmations : []) {
      const field = next.find(
        (e) =>
          e.type === 'checkbox' &&
          e.name === saved.name &&
          e.dataset.confirmationKey === saved.key &&
          formKey(e) === saved.form,
      );
      if (field) field.checked = saved.checked;
    }
    for (const secret of sameRevision ? secrets : []) {
      const field = find(secret);
      if (field) field.value = secret.value;
    }
    if (
      focused &&
      (sameRevision || !controls.some((element) => element === active && element.type === 'password'))
    ) {
      const field = find(focused);
      if (field && !field.disabled) {
        // Keep an unsaved choice only while its server baseline is unchanged.
        // A newer run/control decision wins over an older focused DOM value.
        if (
          !focused.policy ||
          focused.renderedValue === [...(field.options ?? [])].find((option) => option.defaultSelected)?.value
        )
          field.value = focused.value;
        field.focus({ preventScroll: true });
        if (
          typeof focused.start === 'number' &&
          ['text', 'search', 'password', 'email', 'url'].includes(field.type)
        )
          try {
            field.setSelectionRange(focused.start, focused.end);
          } catch {}
      }
    }
    if (!sameRevision && secrets.length)
      content.insertAdjacentHTML?.(
        'afterbegin',
        '<p role="status">配置已由其他操作修改，未提交的 Token 已清空；请核对当前接口后重新输入。</p>',
      );
    if (keepScroll) window.scrollTo({ top: scroll, behavior: 'instant' });
  };
}

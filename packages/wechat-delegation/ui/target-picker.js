window.createWechatTargetPicker = ({ el, button, load, onChange }) => {
  let selected = null, opened = false, kind = 'all', query = '', items = [], cursor = null;
  let counts = null;
  let loading = false, pending = false, total = 0, generation = 0, debounce, poll, force = false;
  const labelId = 'wechat-target-label', listId = 'wechat-target-list';
  const trigger = button('选择真实好友或群', () => opened ? close() : open());
  trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-labelledby', labelId);
  trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-controls', listId); trigger.setAttribute('aria-expanded', 'false');
  const input = el('input', { type: 'search', maxLength: 128, placeholder: '搜索备注、昵称或微信 ID', 'aria-label': '搜索好友或群', autocomplete: 'off' });
  const list = el('div', { id: listId, role: 'listbox', 'aria-label': '好友与群候选', class: 'target-list' });
  const status = el('small', { id: 'target-status', class: 'muted', role: 'status', 'aria-live': 'polite', text: '打开后加载；仅显示当前账号已核实的对象。' });
  const retry = button('重新核对', () => { force = true; resetResults(); }); retry.hidden = true;
  const more = button('加载更多', () => fetchPage(true)); more.hidden = true;
  const tabs = ['all', 'direct', 'group'].map(value => {
    const node = button(value === 'all' ? '全部' : value === 'direct' ? '好友' : '群', () => {
      if (kind === value) return; kind = value; resetResults();
    });
    node.setAttribute('role', 'tab'); node.setAttribute('aria-label', value === 'all' ? '全部' : value === 'direct' ? '好友' : '群'); node.dataset.kind = value; return node;
  });
  const popup = el('div', { class: 'target-popup', hidden: true }, [el('div', { class: 'target-tabs', role: 'tablist', 'aria-label': '对象类型' }, tabs), input, list, status,
    el('div', { class: 'target-footer' }, [retry, more])]);
  const identity = el('small', { class: 'muted' });
  const node = el('div', { class: 'field target-picker' }, [el('label', { id: labelId, text: '指定好友或群' }), trigger, identity, popup]);
  const key = value => `${value.kind}:${value.id}`;
  function render() {
    for (const tab of tabs) {
      tab.setAttribute('aria-selected', String(tab.dataset.kind === kind));
      const label = tab.getAttribute('aria-label'), count = counts ? tab.dataset.kind === 'all' ? counts.direct + counts.group : counts[tab.dataset.kind] : null;
      tab.textContent = count === null ? label : `${label} ${count}`;
    }
    const scroll = list.scrollTop;
    list.replaceChildren(...items.map(item => {
      const option = button('', () => { selected = item; renderSelection(); onChange(item); close(); trigger.focus(); });
      option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(selected && key(selected) === key(item))); option.tabIndex = -1;
      option.append(el('span', { text: item.displayName }), el('small', { text: `${item.kind === 'group' ? '群' : '好友'} · ${item.id}` })); return option;
    }));
    list.scrollTop = scroll; more.hidden = !cursor || pending; more.disabled = loading;
    list.setAttribute('aria-busy', String(loading));
  }
  function renderSelection() {
    identity.textContent = selected?.id ?? '打开后从当前账号的已核实名单中选择。';
    trigger.replaceChildren(el('span', { text: selected ? `${selected.displayName} · ${selected.kind === 'group' ? '群' : '好友'}` : '选择真实好友或群' }), el('span', { 'aria-hidden': 'true', text: '▾' }));
  }
  async function fetchPage(append = false) {
    if (!opened || loading || append && !cursor) return;
    const mine = generation, after = append ? cursor : ''; loading = true; retry.hidden = true;
    status.textContent = append ? '正在加载更多…' : '正在查找…'; render();
    const refreshDirectory = force; force = false;
    try {
      const result = await load({ query, kind, cursor: after, ...(refreshDirectory ? { refreshDirectory: true } : {}) });
      if (mine !== generation || !opened) return;
      pending = result.pending === true; counts = result.counts ?? null;
      const next = append ? items.slice() : [];
      for (const item of result.items) if (!next.some(old => key(old) === key(item))) next.push(item);
      items = next; cursor = result.nextCursor; total = result.total ?? items.length;
      status.textContent = pending ? '正在核对当前微信目录，完成后自动显示…' : !items.length ? (query ? '没有找到匹配对象，可换个关键词。' : `当前尚无已核实的${kind === 'group' ? '群' : kind === 'direct' ? '好友' : '对象'}。`) : `已显示 ${items.length} / ${total} 个匹配${kind === 'group' ? '群' : kind === 'direct' ? '好友' : '对象'}。`;
      if (result.unverifiedCount > 0) status.textContent += ` ${result.unverifiedCount} 个对象尚未核实，暂不展示。`;
      if (kind !== 'direct') {
        status.textContent += ' 群范围为已同步且成员关系已核实的群。';
        if (result.groupDiscoveryIncomplete) status.textContent += ' 群同步尚未完成，可重新核对。';
      }
      retry.hidden = pending || !result.unverifiedCount && !result.groupDiscoveryIncomplete;
      if (pending) poll = setTimeout(() => fetchPage(), 1500);
    } catch (error) {
      if (mine !== generation || !opened) return;
      status.textContent = `目录加载未完成：${error.message}`; retry.hidden = false;
    } finally { if (mine === generation) { loading = false; render(); } }
  }
  function resetResults() {
    clearTimeout(debounce); clearTimeout(poll); generation++; loading = false; pending = false; items = []; cursor = null; total = 0; counts = null;
    render(); if (opened) fetchPage();
  }
  function close() {
    opened = false; popup.hidden = true; trigger.setAttribute('aria-expanded', 'false');
    clearTimeout(debounce); clearTimeout(poll); generation++; loading = false;
  }
  function open() {
    opened = true; popup.hidden = false; trigger.setAttribute('aria-expanded', 'true'); query = ''; input.value = '';
    resetResults(); input.focus();
    requestAnimationFrame(() => {
      const bounds = node.getBoundingClientRect(), below = innerHeight - bounds.bottom, above = bounds.top;
      const flip = below < 300 && above > below; popup.classList.toggle('above', flip);
      list.style.maxHeight = `${Math.max(100, Math.min(260, (flip ? above : below) - 155))}px`;
    });
  }
  let composing = false;
  input.addEventListener('compositionstart', () => { composing = true; clearTimeout(debounce); clearTimeout(poll); generation++; loading = false; });
  const search = () => {
    if (composing) return;
    query = input.value; clearTimeout(debounce); clearTimeout(poll); generation++; loading = false; items = []; cursor = null; counts = null; render();
    debounce = setTimeout(() => fetchPage(), 250);
  };
  input.addEventListener('input', search);
  input.addEventListener('compositionend', () => { composing = false; search(); });
  input.addEventListener('keydown', event => {
    if (event.isComposing || composing) return;
    if (event.key === 'Enter') { event.preventDefault(); return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); list.querySelector('[role=option]')?.focus(); }
  });
  trigger.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); if (!opened) open(); else input.focus(); } });
  list.addEventListener('keydown', event => {
    const options = [...list.querySelectorAll('[role=option]')], index = options.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length; options[next]?.focus();
    }
  });
  node.addEventListener('keydown', event => { if (event.key === 'Escape' && opened) { event.preventDefault(); event.stopPropagation(); close(); trigger.focus(); } });
  list.addEventListener('scroll', () => { if (list.scrollTop + list.clientHeight >= list.scrollHeight - 24) fetchPage(true); }, { passive: true });
  document.addEventListener('pointerdown', event => { if (opened && !node.contains(event.target)) close(); });
  node.addEventListener('focusout', event => { if (opened && event.relatedTarget && !node.contains(event.relatedTarget)) close(); });
  renderSelection();
  return { node, trigger, get value() { return selected ? JSON.stringify({ id: selected.id, kind: selected.kind }) : ''; },
    set(value, displayName) { const item = JSON.parse(value); selected = { ...item, displayName: displayName ?? item.id }; kind = item.kind; renderSelection(); onChange(selected); },
    lock(value) { trigger.disabled = value; if (value) close(); },
    clear() { selected = null; renderSelection(); onChange(null); },
    reset() { close(); selected = null; items = []; cursor = null; renderSelection(); onChange(null); },
    refresh() { force = true; resetResults(); } };
};

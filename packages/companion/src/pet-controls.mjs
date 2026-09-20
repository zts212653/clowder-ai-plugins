/** Transient controls. The Host owns native placement, movement and hiding. */
export function bindPetControls(client, { action, error, changed }) {
  const $ = id => document.getElementById(id);
  const body = $('pet');
  let panel = 'none', layoutRevision = 0, drag, suppressClick = false;
  async function show(next) {
    if (panel !== next && $(next)) $(next).style.maxHeight = '500px';
    panel = next;
    for (const id of ['actions', 'menu', 'chat']) $(id).hidden = id !== next;
    body.setAttribute('aria-expanded', String(next !== 'none'));
    const node = $(next);
    const revision = ++layoutRevision;
    try {
      const placed = await client.layout(next, Math.max(120, Math.ceil(node?.offsetWidth ?? 120)), Math.max(32, Math.ceil(node?.offsetHeight ?? 130)));
      if (revision !== layoutRevision) return;
      $('anchor').style.left = `${placed.pet.x}px`; $('anchor').style.top = `${placed.pet.y}px`;
      if (node) { node.style.left = `${placed.panel.x}px`; node.style.top = `${placed.panel.y}px`; node.style.maxHeight = `${placed.panel.height}px`; }
      if (next === 'chat') $('message').focus({ preventScroll: true });
      if (next === 'menu') $('menu').querySelector('button').focus({ preventScroll: true });
      changed(next);
    } catch (cause) { error(cause); }
  }
  body.onclick = event => {
    if (suppressClick) { suppressClick = false; return; }
    if (event.detail > 1) return;
    void show(panel === 'actions' ? 'none' : 'actions');
  };
  body.oncontextmenu = event => { event.preventDefault(); void show('menu'); };
  body.onkeydown = event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); void show('menu'); }
  };
  body.onpointerdown = event => {
    if (event.button !== 0) return;
    drag = { id: event.pointerId, x: event.screenX, y: event.screenY };
    body.setPointerCapture(event.pointerId);
    void client.drag('start').catch(error);
  };
  body.onpointermove = event => {
    if (drag && Math.hypot(event.screenX - drag.x, event.screenY - drag.y) >= 6) suppressClick = true;
  };
  for (const name of ['pointerup', 'pointercancel']) body.addEventListener(name, () => {
    drag = undefined; void client.drag('end').catch(error);
  });
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest('#anchor, .floating')) void show('none');
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && panel !== 'none') { event.preventDefault(); void show('none'); body.focus(); }
  });
  document.querySelectorAll('[data-action]').forEach(button => button.onclick = () => {
    const kind = button.dataset.action;
    if (kind === 'write' || kind === 'history') { void show('chat'); return; }
    if (kind === 'dismiss') { void show('none'); return; }
    action(kind);
  });
  const sizes = new WeakMap();
  const observer = new ResizeObserver(entries => {
    for (const entry of entries) {
      const size = `${entry.contentRect.width}:${entry.contentRect.height}`;
      const previous = sizes.get(entry.target); sizes.set(entry.target, size);
      if (previous && previous !== size && entry.target.id === panel && !entry.target.hidden) void show(panel);
    }
  });
  for (const id of ['actions', 'menu', 'chat']) observer.observe($(id));
  window.addEventListener('beforeunload', () => observer.disconnect());
  return { get panel() { return panel; }, show, dismiss() { if (drag) suppressClick = true; void show('none'); } };
}

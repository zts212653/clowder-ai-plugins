/** Transient controls. The Host owns native placement, movement and hiding. */
export function bindPetControls(client, { action, error, changed, moved = () => {} }) {
  const $ = id => document.getElementById(id);
  const body = $('pet');
  const panelIds = ['actions', 'menu', 'chat', 'bubble', 'decisions', 'transcript', 'settings'];
  let panel = 'none', ambientPanel = 'none', layoutRevision = 0, drag, suppressClick = false;
  async function show(next) {
    if (next === 'none' && ambientPanel !== 'none') next = ambientPanel;
    const previousPanel = panel;
    const node = $(next);
    // Host placement caps the current rendered height. Release that cap before
    // every explicit remeasure so a taller state of the same panel can grow.
    if (node) node.style.maxHeight = '500px';
    panel = next;
    for (const id of panelIds) $(id).hidden = id !== next;
    body.setAttribute('aria-expanded', String(!['none', 'bubble'].includes(next)));
    const revision = ++layoutRevision;
    try {
      const placed = await client.layout(next, Math.max(120, Math.ceil(node?.offsetWidth ?? 120)), Math.max(32, Math.ceil(node?.offsetHeight ?? 130)));
      if (revision !== layoutRevision) return;
      $('anchor').style.left = `${placed.pet.x}px`; $('anchor').style.top = `${placed.pet.y}px`;
      if (node) { node.style.left = `${placed.panel.x}px`; node.style.top = `${placed.panel.y}px`; node.style.maxHeight = `${placed.panel.height}px`; }
      if (previousPanel !== next) {
        if (next === 'chat') $('message').focus({ preventScroll: true });
        if (next === 'transcript') $('call-message').focus({ preventScroll: true });
        if (next === 'settings') $('settings-back').focus({ preventScroll: true });
        if (next === 'decisions') $('decision-reload').focus({ preventScroll: true });
        if (next === 'menu') $('menu').querySelector('button').focus({ preventScroll: true });
        changed(next);
      }
    } catch (cause) {
      if (revision !== layoutRevision) return;
      panel = previousPanel;
      for (const id of panelIds) $(id).hidden = id !== panel;
      body.setAttribute('aria-expanded', String(!['none', 'bubble'].includes(panel)));
      error(cause, { panel: next });
    }
  }
  body.onclick = event => {
    if (suppressClick) { suppressClick = false; return; }
    if (event.detail > 1) return;
    void show(panel === 'menu' ? 'none' : 'menu');
  };
  body.oncontextmenu = event => { event.preventDefault(); void show('menu'); };
  body.onkeydown = event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); void show('menu'); }
  };
  body.onpointerdown = event => {
    if (event.button !== 0) return;
    const current = { id: event.pointerId, x: event.screenX, y: event.screenY, armed: false };
    drag = current;
    body.setPointerCapture(event.pointerId);
    void client.drag('start').then(() => { if (drag === current) current.armed = true; }).catch(error);
  };
  body.onpointermove = event => {
    if (!drag) return;
    const dx = event.screenX - drag.x, dy = event.screenY - drag.y;
    if (Math.hypot(dx, dy) < 6) return;
    suppressClick = true;
    if (drag.armed) moved(dx, dy);
    drag.x = event.screenX; drag.y = event.screenY;
  };
  for (const name of ['pointerup', 'pointercancel']) body.addEventListener(name, () => {
    drag = undefined; moved('stop'); void client.drag('end').catch(error);
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
    if (kind === 'transcript') { void show('transcript'); return; }
    if (kind === 'settings') { void show('settings'); return; }
    if (kind === 'decisions') { void show('decisions'); return; }
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
  for (const id of panelIds) observer.observe($(id));
  window.addEventListener('beforeunload', () => observer.disconnect());
  return {
    get panel() { return panel; }, show,
    setAmbient(value) {
      const next = value === true ? 'bubble' : value === false ? 'none' : value;
      if (!['none', 'bubble', 'actions'].includes(next)) return Promise.resolve();
      if (ambientPanel === next) return Promise.resolve();
      ambientPanel = next;
      return ['none', 'bubble', 'actions'].includes(panel) ? show('none') : Promise.resolve();
    },
    dismiss() { if (drag) suppressClick = true; void show('none'); },
  };
}

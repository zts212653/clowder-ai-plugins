/** Transient controls. The Host owns native placement, movement and hiding. */
export function bindPetControls(client, { action, error, changed, moved = () => {} }) {
  const $ = id => document.getElementById(id);
  const body = $('pet');
  const panelIds = ['actions', 'menu', 'chat', 'bubble', 'decisions', 'transcript', 'settings'];
  const desiredSizes = new WeakMap();
  let panel = 'none', ambientPanel = 'none', layoutRevision = 0, layoutScheduled = false, drag, suppressClick = false;
  const measure = node => {
    if (!node) return { width: 120, height: 130 };
    // Host placement is an applied cap, not the panel's desired geometry.
    // Release it synchronously while measuring so CSS height and nested flex
    // overflow can expose their natural demand, then restore it before paint.
    const appliedMaxHeight = node.style.maxHeight;
    node.style.maxHeight = '';
    const desired = {
      width: Math.min(420, Math.max(120, Math.ceil(Math.max(node.offsetWidth, node.scrollWidth)))),
      height: Math.min(500, Math.max(32, Math.ceil(Math.max(node.offsetHeight, node.scrollHeight)))),
    };
    node.style.maxHeight = appliedMaxHeight;
    return desired;
  };
  async function show(next) {
    if (next === 'none' && ambientPanel !== 'none') next = ambientPanel;
    const previousPanel = panel;
    const node = $(next);
    panel = next;
    for (const id of panelIds) $(id).hidden = id !== next;
    body.setAttribute('aria-expanded', String(!['none', 'bubble'].includes(next)));
    const desired = measure(node);
    if (node) desiredSizes.set(node, `${desired.width}:${desired.height}`);
    const revision = ++layoutRevision;
    try {
      const placed = await client.layout(next, desired.width, desired.height);
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
  function remeasure() {
    if (layoutScheduled) return;
    layoutScheduled = true;
    queueMicrotask(() => {
      layoutScheduled = false;
      const node = $(panel);
      if (!node || node.hidden) return;
      const desired = measure(node);
      const key = `${desired.width}:${desired.height}`;
      if (desiredSizes.get(node) === key) return;
      void show(panel);
    });
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
  const observer = new MutationObserver(records => {
    const current = $(panel);
    if (!current || current.hidden) return;
    // Root visibility is already handled by show(). Descendant visibility and
    // text/row mutations are content demand and may require a larger surface.
    if (records.some(record => record.type !== 'attributes' || !panelIds.includes(record.target.id))) remeasure();
  });
  for (const id of panelIds) observer.observe($(id), {
    subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'],
  });
  window.addEventListener('beforeunload', () => observer.disconnect());
  return {
    get panel() { return panel; }, show, remeasure,
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

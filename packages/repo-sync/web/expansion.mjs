function historyKey(content) {
  const project = globalThis.location ? new URL(location.href).searchParams.get('project') ?? 'default' : 'default';
  return `repo-sync-history-open:${project}:${content?.dataset?.binding ?? 'setup'}`;
}
export function rememberExpansion(key, states) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key)) ?? {};
    const manual = Array.isArray(saved) ? Object.fromEntries(saved.map((id) => [id, true])) : saved;
    sessionStorage.setItem(key, JSON.stringify({ ...manual, ...states }));
  } catch {}
}
export function setAllExpansion(content, key, open) {
  const stages = [...content.querySelectorAll('[data-stage]')];
  const children = [...content.querySelectorAll('.flow-child-disclosure')];
  rememberExpansion(key, Object.fromEntries(children.map((e) => [`details:${e.dataset.persistDetails}`, open])));
  for (const child of children) child.open = open;
  rememberExpansion(key, { ...Object.fromEntries(stages.map((stage) => [stage.dataset.stage, open])), 'flow:selection': null });
  for (const stage of stages) stage.open = open;
  for (const step of content.querySelectorAll('[data-step-key]')) step.hidden = false;
  for (const node of content.querySelectorAll('[data-flow-node]')) node.setAttribute('aria-pressed', 'false');
  const hint = content.querySelector('[data-flow-inspector-hint]');
  if (hint) hint.hidden = open;
}
export function restoreExpansion(content, _snapshot, _selected, key) {
  let expanded;
  try {
    expanded = JSON.parse(sessionStorage.getItem(key));
  } catch {}
  for (const element of content.querySelectorAll('[data-stage]')) {
    const id = element.dataset.stage;
    const manual = Array.isArray(expanded) ? expanded.includes(id) : expanded?.[id];
    element.open = Boolean(manual);
  }
  for (const element of content.querySelectorAll('[data-persist-details]')) {
    if (element.dataset.persistDetails === 'history') {
      try {
        const manual = sessionStorage.getItem(historyKey(content));
        if (manual !== null) element.open = manual === 'true';
      } catch {}
    } else if (expanded?.[`details:${element.dataset.persistDetails}`] !== undefined)
      element.open = expanded[`details:${element.dataset.persistDetails}`] === true;
  }
}
export function initializeExpansion(getKey) {
  document.addEventListener('click', (event) => {
    const summary = event.target.closest('[data-stage] > summary, [data-persist-details] > summary');
    if (!summary) return;
    const detail = summary.parentElement;
    if (detail.dataset.persistDetails === 'history') {
      try { sessionStorage.setItem(historyKey(document.getElementById('content')), String(!detail.open)); } catch {}
      return;
    }
    const id = detail.dataset.stage ?? `details:${detail.dataset.persistDetails}`;
    rememberExpansion(getKey(), { [id]: !detail.open });
  });
}

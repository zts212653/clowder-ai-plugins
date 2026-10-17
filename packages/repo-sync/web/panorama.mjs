import { nextAction } from './action-policy.mjs';
import { stageGroups, stageSummary } from './attempts.mjs';
import { rememberExpansion } from './expansion.mjs';
import { currentStage, preDeliveryPresentation, stagePresentation } from './flow-stage.mjs';
import { projectStep } from './step-plan.mjs';
import { esc, stageOf } from './ui.mjs';

const names = ['确认范围', '准备交付', '发布 PR', '审核合入', '核验接收'];
const marks = {
  DONE: '✓',
  RUNNING: '◌',
  FAILED: '×',
  PENDING: '○',
  WAITING: '!',
  AUTO_WAIT: '◷',
  UNRECORDED: '—',
  SKIPPED: '—',
};
const labels = {
  DONE: '已完成',
  RUNNING: '执行中',
  FAILED: '异常',
  PENDING: '未执行',
  WAITING: '等待人工',
  AUTO_WAIT: '系统等待',
  UNRECORDED: '未记录',
  SKIPPED: '不适用',
};
export function panorama(snapshot, record, historical) {
  return `<section class="flow-canvas" data-flow-canvas aria-label="五阶段同步流程全景"><div class="flow-canvas-heading"><h2>本笔同步流程</h2><p>点击阶段或子步骤，同页查看结果；执行详情用于排障。</p><div class="flow-legend">✓ 完成 · ◌ 执行 · ◷ 自动等待 · ! 人工 · × 异常</div></div><div class="panorama-grid">${cards(snapshot, record, historical)}</div></section>`;
}
function cards(snapshot, record, historical) {
  const delivery = record?.delivery ?? snapshot.state?.active;
  const policy = nextAction(snapshot, delivery, historical);
  const current = currentStage(delivery, policy, historical);
  const task = snapshot.operation;
  const owns = !delivery || task?.deliveryId === delivery.id || task?.deliveryIds?.includes(delivery.id);
  const error =
    delivery?.error ??
    (snapshot.state?.automation?.status === 'FAILED' ? snapshot.state.automation.error : null);
  const recordedFailure = record?.tasks?.flatMap((t) => t.steps ?? []).findLast((s) => s.status === 'FAILED');
  const failed =
    !historical && owns && task?.persistence?.status === 'FAILED'
      ? 5
      : !historical && owns && task?.status === 'FAILED'
        ? (task.steps?.findLast((s) => s.status === 'FAILED')?.stage ?? policy.stage)
        : error
          ? historical
            ? (recordedFailure?.stage ?? stageOf(delivery))
            : policy.stage
          : 0;
  return names
    .map((name, index) => {
      const stage = index + 1,
        state = delivery
          ? stagePresentation(
              stage,
              delivery,
              current,
              failed,
              historical ? undefined : snapshot.state?.automation,
            )
          : preDeliveryPresentation(stage, task, policy);
      const groups = [...stageGroups(stage, record, snapshot.operation, historical, snapshot).values()];
      return `<article class="flow-phase" data-flow-stage="${stage}" data-flow-state="${state.state}"><button type="button" class="flow-phase-heading" data-flow-stage-select="${stage}"><span class="flow-state-mark">${state.mark}</span><span><b>${stage} · ${name}</b><small>${state.caption}</small></span></button><p class="flow-phase-summary">${esc(stageSummary(stage, record, task, historical, snapshot, state.state))}</p><details class="flow-child-disclosure" data-persist-details="flow-children-${stage}"><summary>查看 ${groups.length} 项子步骤</summary><ol class="flow-children">${groups
        .map((g) => {
          const projected = projectStep(g),
            s = projected.status;
          return `<li><button type="button" class="flow-node" data-flow-parent="${stage}" data-flow-node="${esc(g.key)}" data-flow-node-status="${s}" aria-label="${stage} · ${esc(g.label)} · ${labels[s]}"><span class="flow-state-mark">${marks[s]}</span><span><b>${esc(g.label)}</b><small>${labels[s]}</small></span></button></li>`;
        })
        .join('')}</ol></details></article>`;
    })
    .join('');
}
export function restorePanorama(content, key) {
  let selection;
  try {
    selection = JSON.parse(sessionStorage.getItem(key))?.['flow:selection'];
  } catch {}
  const open = [...content.querySelectorAll('[data-stage][open]')];
  const hint = content.querySelector('[data-flow-inspector-hint]');
  if (hint) hint.hidden = open.length > 0;
  for (const node of content.querySelectorAll('[data-flow-node]')) {
    const selected =
      open.some((d) => d.dataset.stage === node.dataset.flowParent) &&
      selection?.node === node.dataset.flowNode;
    node.setAttribute('aria-pressed', String(selected));
  }
  for (const panel of content.querySelectorAll('[data-stage]')) {
    const node = panel.open && selection?.stage === panel.dataset.stage ? selection.node : null;
    for (const step of panel.querySelectorAll('[data-step-key]'))
      step.hidden = Boolean(node && step.dataset.stepKey !== node);
  }
}
export function updatePanorama(content, snapshot, record, historical, key) {
  const canvas = content.querySelector('[data-flow-canvas] .panorama-grid');
  if (canvas) {
    const left = canvas.scrollLeft;
    const focused = document.activeElement?.dataset?.flowNode;
    const open = new Set(
      [...canvas.querySelectorAll('[data-persist-details][open]')].map((e) => e.dataset.persistDetails),
    );
    canvas.innerHTML = cards(snapshot, record, historical);
    for (const panel of canvas.querySelectorAll('[data-persist-details]'))
      panel.open = open.has(panel.dataset.persistDetails);
    canvas.scrollLeft = left;
    if (focused)
      [...canvas.querySelectorAll('[data-flow-node]')]
        .find((e) => e.dataset.flowNode === focused)
        ?.focus({ preventScroll: true });
  }
  restorePanorama(content, key);
}
export function initializePanorama(getKey) {
  document.addEventListener(
    'toggle',
    (event) => {
      if (event.target.matches?.('[data-stage]'))
        restorePanorama(document.getElementById('content'), getKey());
    },
    true,
  );
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-flow-node], [data-flow-stage-select]');
    if (!button) return;
    const stage = button.dataset.flowParent ?? button.dataset.flowStageSelect;
    const content = document.getElementById('content');
    const states = {};
    for (const panel of content.querySelectorAll('[data-stage]')) {
      panel.open = panel.dataset.stage === stage;
      states[panel.dataset.stage] = panel.open;
    }
    states['flow:selection'] = { stage, node: button.dataset.flowNode ?? null };
    rememberExpansion(getKey(), states);
    restorePanorama(content, getKey());
  });
}
export function retainPanoramaFocus(content) {
  const active = document.activeElement,
    scope = content.dataset.actionScope;
  const positions = ['.round-items', '.panorama-grid'].map((selector) => {
    const node = content.querySelector(selector);
    return { selector, top: node?.scrollTop ?? 0, left: node?.scrollLeft ?? 0 };
  });
  const attributes = ['flowNode', 'flowStageSelect', 'roundFilter', 'roundPage'];
  const key = attributes.find((key) => active?.dataset?.[key]);
  const value = key && active.dataset[key];
  return () => {
    if (content.dataset.actionScope !== scope) return;
    for (const p of positions) {
      const node = content.querySelector(p.selector);
      if (node) {
        node.scrollTop = p.top;
        node.scrollLeft = p.left;
      }
    }
    if (key)
      [...content.querySelectorAll('button')]
        .find((e) => e.dataset[key] === value)
        ?.focus({ preventScroll: true });
  };
}

import { defaultBinding } from './binding.mjs';
import { createBindingUI } from './binding-ui.mjs';
import { scenarios } from './data.mjs';
import { deliveryPhase } from './delivery.mjs';
import { renderDelivery } from './render-delivery.mjs';
import { renderMapping } from './render-detail.mjs';
import { renderOverview } from './render-overview.mjs';
import { createState, reduce } from './state.mjs';
import { readState, storageKey, writeState } from './storage.mjs';

const element = (id) => document.getElementById(id);
let state = readState();
let view = 'overview';
let technicalOpen = false;
let auditOpen = false;
let selectedPhase = state.active?.phase ?? 1;
let selectedId = state.active?.id ?? state.deliveries[0].id;
const bindingUI = createBindingUI(() => state, replaceState, render, toast);
function replaceState(next, nextView) {
  state = next;
  view = nextView;
  selectedPhase = state.active?.phase ?? 1;
  selectedId = state.active?.id ?? state.deliveries[0].id;
  persist();
}
element('scenario').innerHTML = Object.entries(scenarios)
  .map(([key, label]) => `<option value="${key}">${label}</option>`)
  .join('');
function persist() {
  try {
    writeState(state);
  } catch {
    toast('浏览器未允许本地保存，当前交互仍可使用');
  }
}
function render() {
  element('scenario').value = state.scenario;
  element('overview').innerHTML = view === 'delivery' ? '' : renderOverview(state, selectedPhase, technicalOpen);
  element('delivery').innerHTML =
    view === 'delivery' ? renderDelivery(state, selectedId, selectedPhase, { technicalOpen, auditOpen }) : '';
  element('mapping').innerHTML =
    state.binding.status === 'ready'
      ? `<button type="button" class="text-button" data-delivery="${selectedId}">← 返回本次同步</button>${renderMapping(state, selectedId)}`
      : '<div class="notice">初始化完成后才会建立提交与对象映射。</div>';
  element('configuration').innerHTML = bindingUI.render();
  element('repo-label').textContent =
    state.binding.status === 'draft'
      ? '尚未绑定仓库'
      : state.binding.externalUrl
          .replace(/\.git$/, '')
          .split(/[/:]/)
          .slice(-2)
          .join(' / ');
  for (const name of ['overview', 'mapping', 'delivery', 'configuration']) element(name).hidden = name !== view;
  const names = {
    overview: '同步工作台',
    mapping: '版本与对象对照',
    delivery: '本次同步',
    configuration: '仓库设置',
  };
  element('view-name').textContent = names[view];
  element('page-title').textContent = view === 'overview' ? '仓库同步' : names[view];
  element('page-subtitle').textContent = {
    overview: '查看当前进度，并完成下一步操作。',
    delivery: '当前操作、检查结果与本次审计都在这里。',
    mapping: '查看对应关系，返回本次同步继续操作。',
    configuration: '连接两个仓库，确认从哪个版本开始接收。',
  }[view];
  for (const button of document.querySelectorAll('.nav-item')) {
    const current =
      button.dataset.view === view || (['delivery', 'mapping'].includes(view) && button.dataset.view === 'overview');
    button.classList.toggle('selected', current);
    button.setAttribute('aria-current', current ? 'page' : 'false');
  }
}
function dispatch(type, extra = {}) {
  state = reduce(state, { type, ...extra });
  if (view !== 'delivery' || selectedId === state.active?.id) {
    selectedPhase = state.active?.phase ?? 1;
    selectedId = state.active?.id ?? selectedId;
  }
  persist();
  render();
}
let toastTimer;
function toast(message) {
  element('toast').textContent = message;
  element('toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element('toast').classList.remove('visible'), 2600);
}
async function copyCommit(commit) {
  try {
    await navigator.clipboard.writeText(commit);
    toast('提交 ID 已复制');
  } catch {
    toast(`提交 ID：${commit}`);
  }
}
function navigate(button) {
  if (button.dataset.view) {
    view = button.dataset.view;
    technicalOpen = false;
    auditOpen = false;
    selectedPhase = state.active?.phase ?? 1;
    render();
    return true;
  }
  if (button.dataset.phase) {
    selectedPhase = Number(button.dataset.phase);
    render();
    return true;
  }
  if (button.dataset.delivery || button.dataset.audit || button.dataset.help) {
    selectedId = button.dataset.delivery ?? button.dataset.audit ?? button.dataset.help;
    const delivery = state.deliveries.find((item) => item.id === selectedId);
    if (!delivery) {
      toast('这笔同步不存在');
      return true;
    }
    selectedPhase = deliveryPhase(state, delivery) || 1;
    auditOpen = Boolean(button.dataset.audit);
    technicalOpen = Boolean(button.dataset.help);
    view = 'delivery';
    render();
    if (auditOpen) element('delivery-audit').scrollIntoView({ block: 'start' });
    if (button.dataset.help) element('baseline-help').scrollIntoView({ block: 'start' });
    return true;
  }
  if (button.dataset.map) {
    selectedId = button.dataset.map;
    view = 'mapping';
    render();
    return true;
  }
  return false;
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button || bindingUI.action(button.id) || navigate(button)) return;
  if (button.dataset.copy) copyCommit(button.dataset.copy);
  if (['start', 'advance', 'recover', 'external'].includes(button.id)) dispatch(button.id);
  if (button.id === 'auto-step') dispatch('advance');
  if (button.id === 'adapter-button') element('adapter-dialog').showModal();
  if (button.id === 'close-adapter') element('adapter-dialog').close();
  if (button.id === 'demo-toggle') {
    const hidden = !element('demo-controls').hidden;
    element('demo-controls').hidden = hidden;
    button.textContent = hidden ? '演示场景' : '收起演示场景';
    button.setAttribute('aria-expanded', String(!hidden));
  }
  if (button.id === 'reset') reset(element('scenario').value);
});
function reset(scenario) {
  const binding = state.binding.status === 'ready' || scenario === 'unconfigured' ? state.binding : defaultBinding();
  const next = createState(scenario, binding);
  next.archives = state.archives;
  state = next;
  bindingUI.reset();
  selectedPhase = state.active?.phase ?? 1;
  selectedId = state.active?.id ?? state.deliveries[0].id;
  technicalOpen = false;
  auditOpen = false;
  view = 'overview';
  persist();
  render();
  toast('演示状态已重置');
}
element('scenario').addEventListener('change', (event) => reset(event.target.value));
document.addEventListener('change', (event) => {
  bindingUI.changed(event);
  if (event.target.id === 'mapping-delivery') {
    selectedId = event.target.value;
    render();
  }
});
document.addEventListener('input', (event) => bindingUI.changed(event));
document.addEventListener(
  'toggle',
  (event) => {
    if (event.target.id === 'technical-details') technicalOpen = event.target.open;
    if (event.target.id === 'delivery-audit') auditOpen = event.target.open;
  },
  true,
);
document.getElementById('configuration').addEventListener('submit', (event) => event.preventDefault());
window.addEventListener('storage', (event) => {
  if (event.key !== storageKey) return;
  state = readState();
  bindingUI.reset();
  if (view !== 'delivery' || selectedId === state.active?.id) selectedPhase = state.active?.phase ?? 1;
  render();
});
persist();
render();

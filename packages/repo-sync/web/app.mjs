import { guardRenderedScope, snapshotIdentity } from './action-scope.mjs';
import { updateShell } from './app-shell.mjs';
import { captureDraft, configuration, restoreDraft } from './connections.mjs';
import { createBaselineViewer, diagnostics } from './diagnostics.mjs';
import { initializeExpansion, restoreExpansion, setAllExpansion } from './expansion.mjs';
import { hydrateFileRules, initializeFileRules } from './file-rules.mjs';
import { boundaryDeliveryId, currentRecord } from './flow-stage.mjs';
import { initializeFormErrors } from './form-errors.mjs';
import { configurationConfirmation, initializeSubmissions } from './form-submission.mjs';
import { createGithubAuthentication } from './github-auth.mjs';
import { createHistory, recordList } from './history.mjs';
import { createIssueAuthentication, updateIssueFields } from './issue-auth.mjs';
import { updateLiveWorkflow } from './live-workflow.mjs';
import { renderTask } from './operation-view.mjs';
import { createOperations } from './operations.mjs';
import { initializePanorama, restorePanorama, retainPanoramaFocus } from './panorama.mjs';
import { serviceLabel } from './platform.mjs';
import { previewPanel } from './preview-view.mjs';
import { pageProjectId, projectUrl } from './project-scope.mjs';
import { createProjectNavigation } from './projects.mjs';
import { createRecoveryNavigation, showActivity } from './recovery-navigation.mjs';
import { createRoundView } from './round-controller.mjs';
import { createSettingsController } from './settings-controller.mjs';
import { createSetupFlow } from './setup-flow.mjs';
import { createTaskFocus, focusBaselineInput } from './setup-navigation.mjs';
import { createTransfers } from './transfers.mjs';
import { button, esc, sha } from './ui.mjs';
import { updateTagChoice } from './version.mjs';
import { retainView } from './view-state.mjs';
import { workbench } from './workbench.mjs';
import { workflow } from './workflow.mjs';

const VIEWS = ['workbench', 'records', 'configuration'];
const requestedView = new URL(location.href).searchParams.get('view');
let view =
  requestedView && VIEWS.includes(requestedView)
    ? requestedView
    : new URL(location.href).searchParams.has('record')
      ? 'records'
      : 'workbench';

const content = document.getElementById('content');
const errorPanel = document.getElementById('error');
let snapshot;
let mobileDetail = !!new URL(location.href).searchParams.get('record');
let availableTags = [];
const projectNavigation = createProjectNavigation(() => snapshot, saveDraft);
const issueAuthentication = createIssueAuthentication(() => snapshot, refresh, errorPanel);
const githubAuthentication = createGithubAuthentication(() => snapshot, refresh);
const transfers = createTransfers(() => snapshot, refresh);
const projectSettings = createSettingsController(() => snapshot, refresh);
const recovery = createRecoveryNavigation({
  snapshot: () => snapshot,
  changeView,
  action: (...args) => action(...args),
});
const records = createHistory(() => snapshot, render);
const roundView = createRoundView(() => snapshot);
const focusTask = createTaskFocus();
const baselineViewer = createBaselineViewer({ snapshot: () => snapshot, action: (...args) => action(...args) });
const setup = createSetupFlow({
  snapshot: () => snapshot,
  render,
  action: (...args) => action(...args),
});
let preview = null;
const operations = createOperations({
  snapshot: () => snapshot,
  refresh,
  completed: showActionResult,
  errorPanel,
  onTask,
});
function draftKey() {
  return `repo-sync-draft:${pageProjectId === 'default' ? '' : `${pageProjectId}:`}${snapshot?.config?.bindingId ?? 'setup'}:${view}:${records.get().selected}`;
}
function saveDraft() {
  if (!snapshot || !content.childElementCount) return true;
  try {
    sessionStorage.setItem(draftKey(), JSON.stringify(captureDraft()));
    return true;
  } catch {
    return false;
  }
}
function savedDraft() {
  try {
    return JSON.parse(sessionStorage.getItem(draftKey())) ?? [];
  } catch {
    return [];
  }
}
function expandedKey() {
  const selection = records.get();
  const id =
    selection.selected === 'current'
      ? (snapshot.state?.active?.id ?? boundaryDeliveryId(snapshot.state) ?? snapshot.state?.automation?.id)
      : selection.selected;
  return `${draftKey()}:expanded:${id ?? 'setup'}`;
}
function render({ keepScroll = false } = {}) {
  const restoreNodeFocus = retainPanoramaFocus(content);
  const restoreView = retainView(content, snapshot.config?.bindingId, snapshot.connection?.revision);
  if (
    preview &&
    (preview.bindingId !== snapshot.config?.bindingId ||
      preview.base.upstream !== snapshot.state?.accepted.upstream ||
      preview.base.internal !== snapshot.state?.accepted.internal)
  )
    preview = null;
  document.getElementById('mode').textContent = serviceLabel(snapshot);
  content.innerHTML =
    view === 'configuration'
      ? configuration(snapshot, esc, sha, button, setup.state())
      : view === 'records'
        ? recordsPage(snapshot, records.get(), mobileDetail)
        : workbench(snapshot, records.get(), availableTags, mobileDetail);
  if (view === 'workbench') content.insertAdjacentHTML('afterbegin', roundView.render());
  transfers.render(content, view);
  updateShell(snapshot, view);
  recovery.mount(content, view);
  content.dataset.binding = snapshot.config?.bindingId ?? 'setup';
  content.dataset.revision = snapshot.connection?.revision ?? '';
  content.dataset.actionScope = snapshotIdentity(snapshot);
  if (preview && view !== 'configuration' && records.get().selected === 'current' && !snapshot.state?.active)
    content.querySelector('.record-detail')?.insertAdjacentHTML('beforeend', previewPanel(preview));
  content.querySelector('#error-slot')?.append(errorPanel);
  restoreDraft(savedDraft());
  projectSettings.renderFeedback();
  restoreExpansion(
    content,
    snapshot,
    records.get().selected,
    expandedKey(),
    currentRecord(snapshot, records.get())?.delivery ?? snapshot.state?.active,
  );
  restorePanorama(content, expandedKey());
  if (view === 'configuration') {
    const baseline = content.querySelector('form[data-form="inspect-baseline"]')?.closest('.card');
    const panel = diagnostics(snapshot.operation?.error, snapshot, esc);
    if (panel) (baseline ?? content).insertAdjacentHTML(baseline ? 'beforeend' : 'afterbegin', panel);
  }
  for (const form of content.querySelectorAll('form[data-form]')) updateIssueFields(form);
  for (const form of content.querySelectorAll('form[data-accepted-upstream]')) updateTagChoice(form);
  hydrateFileRules();
  baselineViewer.render();
  onTask(snapshot.operation);
  operations.lock();
  restoreView({ keepScroll });
  restoreNodeFocus();
}

function onTask(task) {
  if (!snapshot) return;
  snapshot.operation = task;
  const record = currentRecord(snapshot, records.get());
  const historical =
    records.get().selected !== 'current' && records.get().selected !== snapshot.state?.active?.id;
  showActivity(task);
  if (historical) return;
  if (view === 'configuration' && snapshot.state) return;
  if (!updateLiveWorkflow(content, snapshot, record, task, records.get().selected, expandedKey())) {
    const panel = content.querySelector('#operation');
    if (panel) panel.innerHTML = renderTask(task);
  }
  if (view === 'configuration') focusTask(task, snapshot);
}
let refreshing = 0;
let settlingRefreshes = 0;
async function refresh({ background = false } = {}) {
  const ticket = ++refreshing;
  saveDraft();
  const response = await fetch(projectUrl('/api/status?compact=1'), {
    signal: AbortSignal.timeout(8000),
  });
  const result = await response.json();
  if (response.ok && result.operation) result.operation.observedAt = new Date().toISOString();
  if (!response.ok)
    throw new Error(`${result.code ?? 'STATUS_UNREADABLE'}：${result.message ?? '无法读取工作台'}`);
  if (ticket !== refreshing) return;
  if (!snapshot && result.state?.active) mobileDetail = true;
  snapshot = result;
  if (snapshot.state?.active || snapshot.state?.automation) settlingRefreshes = 0;
  projectNavigation.update(result.workspace);
  if (!snapshot.state && snapshot.operation) view = 'configuration';
  await Promise.all([records.load(true), roundView.load()]);
  render({ keepScroll: background });
  operations.observe(snapshot.operation);
}
initializeFormErrors();
const action = (input, form, expectedScope = content.dataset.actionScope) => {
  if (expectedScope !== snapshotIdentity(snapshot)) {
    staleScope();
    return null;
  }
  return operations.action(input, form?.dataset.form);
};
function staleScope() {
  errorPanel.textContent = '同步状态已变化，请等待页面更新后重试；旧页面操作未执行。';
  errorPanel.hidden = false;
}
guardRenderedScope(content, () => snapshot, staleScope);
initializeFileRules({
  snapshot: () => snapshot,
  action: async (...args) => {
    const result = await action(...args);
    if (args[0].action === 'inspect-baseline') setup.acceptReport(result);
    return result;
  },
  saveDraft,
  errorPanel,
});
document.addEventListener('click', async (event) => {
  const element = event.target.closest('button, [data-reveal]');
  if (!snapshot || !element) return;
  const clickedScope = content.dataset.actionScope;
  await navigate(element);
  if (element.dataset.view) changeView(element.dataset.view);
  if (element.dataset.authFocus) {
    const targetId = element.dataset.authFocus === 'github' ? 'github-source-auth' : 'issue-auth';
    const target = document.getElementById(targetId);
    for (let parent = target; parent; parent = parent.parentElement)
      if (parent.tagName === 'DETAILS') parent.open = true;
    target?.scrollIntoView({ block: 'center' });
    target?.querySelector('input[type="password"], [data-auth-provide], [data-issue-check], [data-github-check]')?.focus({ preventScroll: true });
  }
  if (element.hasAttribute('data-import-settings')) {
    changeView('configuration');
    const panel = content.querySelector('#transfer-settings');
    if (panel) { panel.open = true; panel.scrollIntoView({ block: 'start' }); }
  }
  if (element.dataset.action) {
    mobileDetail = true;
    const result = await action(
      {
        action: element.dataset.action,
        ...(['synchronize', 'resume-sync', 'pause-sync'].includes(element.dataset.action)
          ? {}
          : { deliveryId: snapshot.state?.active?.id }),
        ...(['resume-sync', 'pause-sync'].includes(element.dataset.action)
          ? { runId: snapshot.state.automation.id }
          : {}),
        ...(['start', 'synchronize'].includes(element.dataset.action)
          ? { expectedTarget: snapshot.state?.queue[0]?.target }
          : {}),
      },
      undefined,
      clickedScope,
    );
    showActionResult(element.dataset.action, result);
  }
});
function recordsPage(snapshot, records, mobileDetail) {
  if (!snapshot.state)
    return `<section class="card task"><h2>还没有同步记录</h2><p>完成首次配置并同步一笔之后，这里会按时间列出每笔的版本、PR、阶段与结果。</p><button type="button" data-view="configuration" class="primary">配置仓库 →</button></section>`;
  const active = snapshot.state.active ?? null;
  const selected = records.selected ?? 'current';
  const historical = selected !== 'current' && selected !== active?.id;
  const list = recordList(records, active);
  const shown =
    records.error && !historical
      ? `<p class="record-gap bad" role="alert">× ${esc(records.error)}<br>记录读取失败，原选择保留。</p><button type="button" data-reload-record>重新读取记录</button>`
      : historical && records.detail
        ? `<div class="records-detail-body">${workflow(snapshot, records.detail, true)}</div>`
        : historical
          ? '<p role="status">正在读取所选记录…</p>'
          : '<p class="records-hint" role="status">从左侧选择一笔记录，这里会显示它当时的五阶段过程、对象与时间；当前这一笔请回同步工作台查看。</p>';
  return `<div class="records-page${mobileDetail ? ' mobile-detail' : ''}">${list}<section class="records-detail" aria-label="所选同步记录">${shown}</section></div>`;
}
function changeView(next) {
  saveDraft();
  view = next;
  const url = new URL(location.href);
  if (view === 'workbench') url.searchParams.delete('view');
  else url.searchParams.set('view', view);
  history.replaceState(null, '', url);
  render();
}
async function navigate(element) {
  if (element.dataset.reveal) {
    const target = document.getElementById(element.dataset.reveal);
    for (let parent = target; parent; parent = parent.parentElement)
      if (parent.tagName === 'DETAILS') parent.open = true;
    target?.querySelector('input, button, select')?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'start' });
  }
  if (element.hasAttribute('data-expand-all')) setAllExpansion(content, expandedKey(), true);
  if (element.hasAttribute('data-collapse-all')) setAllExpansion(content, expandedKey(), false);
  if (element.dataset.record) {
    saveDraft();
    mobileDetail = true;
    await records.select(element.dataset.record);
    if (element.dataset.record === 'current') {
      changeView('workbench');
      return;
    }
  }
  if (element.hasAttribute('data-record-back')) {
    mobileDetail = false;
    saveDraft();
    render();
  }
  if (element.hasAttribute('data-record-page')) await records.move(Number(element.dataset.recordPage));
  if (element.hasAttribute('data-reload-record')) {
    await records.load(true);
    render();
  }
  if (element.hasAttribute('data-more-tasks')) await records.moreTasks();
}
function showActionResult(kind, result) {
  if (!result) return;
  if (kind === 'inspect-baseline') return setup.acceptReport(result);
  if (kind === 'preview-sync') {
    preview = result.result;
    render();
    document.getElementById('sync-preview')?.scrollIntoView({ block: 'start' });
  }
  if (kind === 'tags') {
    availableTags = result.result;
    render();
  }
  if (kind === 'heads') {
    setup.heads(result.result);
    const internal = document.getElementById('internal');
    if (!internal) return;
    internal.value = result.result.internal;
    document.getElementById('upstream').placeholder = `最新 ${result.result.upstream}；请填已同步版本`;
    const heads = document.getElementById('observed-heads');
    if (heads)
      heads.innerHTML = `<p>读取成功：外部最新 ${sha(result.result.upstream)}<br>内部当前 ${sha(result.result.internal)}。请核对并填写上次已同步的 U0。</p>`;
    saveDraft();
    focusBaselineInput();
  }
}
initializeSubmissions({
  projectSettings,
  snapshot: () => snapshot,
  action,
  issueAuthentication,
  githubAuthentication,
  records,
  setup,
  complete: (kind, result) => {
    showActionResult(kind, result);
    configurationConfirmation(content, kind, result, snapshot);
    saveDraft();
  },
  activate: () => changeView('workbench'),
});
document.addEventListener('input', saveDraft);
document.addEventListener('change', (event) => {
  if (event.target.matches('[name="mode"]')) {
    const form = event.target.closest('form');
    const closure = form.querySelector('[data-closure]');
    if (closure) closure.hidden = event.target.value === 'version';
  }
  saveDraft();
});
initializeExpansion(expandedKey);
initializePanorama(expandedKey);
projectNavigation
  .load()
  .then(refresh)
  .catch((error) => {
    errorPanel.textContent = error.message;
    errorPanel.hidden = false;
  });
setInterval(() => {
  if (
    ['RUNNING', 'WAITING_REVIEW'].includes(snapshot?.state?.automation?.status) ||
    (['synchronize', 'resume-sync'].includes(snapshot?.operation?.action) &&
      snapshot.operation.status === 'RUNNING') ||
    (snapshot?.operation?.status === 'SUCCEEDED' &&
      !snapshot.state?.active &&
      settlingRefreshes++ < 6)
  )
    refresh({ background: true }).catch(() => {});
}, 5000);

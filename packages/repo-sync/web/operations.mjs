import { captureDraft, restoreDraft } from './connections.mjs';
import { hydrateFileRules } from './file-rules.mjs';
import { clearConfigurationErrors, showConfigurationError } from './form-errors.mjs';
import { renderTask } from './operation-view.mjs';
import { pageProjectId, projectUrl } from './project-scope.mjs';

const longActions = new Set([
  'inspect-baseline',
  'preview-sync',
  'synchronize',
  'resume-sync',
  'pause-sync',
  'configure-continuation',
  'heads',
  'adopt',
  'discover',
  'prepare',
  'recover',
  'tags',
  'select-tag',
  'pr',
  'clear-pr',
  'create-pr',
  'start',
  'issue',
  'sync-issues',
  'receipts',
  'cancel-version',
  'cancel-delivery',
  'inspect-delivery-source',
  'configure-auto-merge',
]);
const active = new Set(['RUNNING', 'CANCELLING', 'STOP_UNCONFIRMED']);
const blocked = (task) => active.has(task?.status) || task?.persistence?.status === 'FAILED';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export function createOperations({ snapshot, refresh, completed, errorPanel, onTask }) {
  let busy = false;
  let watching;
  let current;
  let originalInput;
  let retryingOriginal = false;
  function lock() {
    for (const element of document.querySelectorAll(
      'button[data-action], [data-save-file-rules], [data-remove-rule], [data-baseline-read], form button, input, textarea, select',
    ))
      if (!element.matches('[data-baseline-path], [data-baseline-read]') &&
          !element.closest('.record-list, [data-project-navigation], [data-transfer-upload]'))
        element.disabled = busy || element.hasAttribute('data-preserve-disabled');
  }
  function show(task) {
    current = task;
    if (onTask) onTask(task);
    else document.getElementById('operation').innerHTML = renderTask(task);
  }
  async function request(url, input) {
    if (input && snapshot()?.workspace) input = { ...input, projectId: pageProjectId };
    const response = await fetch(projectUrl(url), {
      method: input ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Repo-Sync-Token': snapshot().token,
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
      signal: AbortSignal.timeout(8000),
    });
    const value = await response.json();
    if (response.ok && value.operation) value.operation.observedAt = new Date().toISOString();
    if (!response.ok) {
      const error = new Error(`${value.code}：${value.message ?? '请求未完成'}`);
      error.code = value.code;
      error.details = value.details;
      throw error;
    }
    return value;
  }
  async function wait(id) {
    while (true) {
      if (bindingChanged(id))
        throw new Error('CONFIGURATION_CHANGED：仓库绑定已变化，请刷新确认，原请求不会重送到新仓库。');
      try {
        const task = (await request(`/api/tasks/${id}`)).operation;
        show(task);
        errorPanel.hidden = true;
        if (waitFinished(task)) return task;
      } catch (error) {
        if (['TASK_UNREADABLE', 'TASK_BINDING_CHANGED', 'CONFIGURATION_CHANGED'].includes(error.code)) throw error;
        await disconnected(error, id);
      }
      await sleep(500);
    }
  }
  const bindingChanged = (id) =>
    originalInput?.requestId === id && snapshot().config?.bindingId !== originalInput.expectedBinding;
  const waitFinished = (task) =>
    !active.has(task.status) || task.persistence?.status === 'FAILED' || task.status === 'STOP_UNCONFIRMED';
  async function disconnected(error, id) {
    if (error.code === 'TOKEN_REJECTED') {
      try {
        await refresh();
      } catch {}
    }
    errorPanel.textContent = `暂时无法读取任务状态，正在查询原任务 ${id}；不会重复提交。${error.code ?? 'CONNECTION_LOST'}`;
    errorPanel.hidden = false;
    if (error.code === 'TASK_NOT_FOUND' && originalInput?.requestId === id) {
      errorPanel.textContent = `暂未找到请求 ${id} 的记录。可继续查询，或重送同一请求；保持原标识，不创建第二笔同步。`;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.retryOriginal = '';
      button.textContent = '重送原请求（保持同一标识）';
      errorPanel.append(button);
    }
  }
  function observe(task) {
    if (watching) {
      lock();
      return;
    }
    busy = blocked(task);
    show(task);
    lock();
    if (task && !task.persistence && ['RUNNING', 'CANCELLING'].includes(task.status)) {
      watching = task.id;
      void wait(task.id)
        .then(async (done) => {
          watching = null;
          busy = blocked(done);
          await refresh();
          if (done.status === 'SUCCEEDED') completed(done.action, { result: done.result });
          lock();
        })
        .catch((error) => {
          watching = null;
          errorPanel.textContent = error.message;
          errorPanel.hidden = false;
        })
        .finally(lock);
    }
  }
  async function runLong(input) {
    const requestId = crypto.randomUUID().replaceAll('-', '');
    watching = requestId;
    originalInput = {
      ...input,
      requestId,
      expectedBinding: snapshot().config.bindingId,
      expectedRevision: snapshot().connection?.revision,
    };
    let value;
    try {
      value = await request('/api/tasks', originalInput);
    } catch (error) {
      if (error.code) throw error;
      errorPanel.textContent = '请求回执暂未取得，正在查询原任务；请勿重复发起。';
      errorPanel.hidden = false;
      document.getElementById('baseline-differences')?.scrollIntoView({ block: 'center' });
    }
    if (value) show(value.operation);
    return wait(requestId);
  }
  function checkOutcome(operation) {
    if (operation.persistence?.status === 'FAILED')
      throw new Error('TASK_STORE_FAILED：业务已结束，但执行记录未保存。请只补存原记录，不重复执行。');
    if (operation.status !== 'SUCCEEDED') {
      const error = new Error(
        `${operation.error?.code ?? operation.status}：${operation.error?.message ?? '当前操作未完成'}`,
      );
      error.code = operation.error?.code;
      error.details = operation.error?.details;
      throw error;
    }
  }
  async function action(input, formKind) {
    if (busy) return;
    busy = true;
    errorPanel.hidden = true;
    clearConfigurationErrors(formKind);
    const drafts = captureDraft();
    lock();
    let operation;
    try {
      let value;
      if (longActions.has(input.action)) {
        operation = await runLong(input);
        checkOutcome(operation);
        value = { result: operation.result };
      } else {
        const configure = [
          'configure',
          'configure-repositories',
          'configure-file-rules',
          'configure-pr',
          'configure-issues',
          'configure-closure',
          'configure-identity',
        ].includes(input.action);
        value = await request(
          '/api/action',
          configure
            ? input
            : {
                ...input,
                expectedBinding: snapshot().config?.bindingId,
                expectedRevision: snapshot().connection?.revision,
              },
        );
      }
      watching = null;
      busy = false;
      await refresh();
      if (
        ['heads', 'baseline-file', 'configure', 'configure-repositories', 'configure-file-rules'].includes(input.action)
      )
        restoreDraft(drafts);
      hydrateFileRules();
      return value;
    } catch (error) {
      watching = null;
      busy = blocked(operation);
      try {
        await refresh();
      } catch {
        /* Preserve the visible form if the server is unavailable. */
      }
      restoreDraft(drafts);
      hydrateFileRules();
      lock();
      showConfigurationError(formKind, error, errorPanel);
    } finally {
      lock();
    }
  }
  async function resendOriginal() {
    if (originalInput && !retryingOriginal) {
      retryingOriginal = true;
      try {
        if (snapshot().config.bindingId !== originalInput.expectedBinding)
          throw new Error('CONFIGURATION_CHANGED：仓库已变化，不能把原请求重送到另一套绑定。请刷新核对。');
        show((await request('/api/tasks', originalInput)).operation);
      } catch (error) {
        errorPanel.textContent = error.message;
        errorPanel.hidden = false;
      } finally {
        retryingOriginal = false;
      }
    }
  }
  async function repairRecord() {
    if (current) {
      try {
        show((await request(`/api/tasks/${current.id}/persist`, {})).operation);
        busy = blocked(current);
        await refresh();
        errorPanel.hidden = true;
      } catch (error) {
        errorPanel.textContent = error.message;
        errorPanel.hidden = false;
      } finally {
        lock();
      }
    }
  }
  document.addEventListener('click', async (event) => {
    if (event.target.closest('[data-retry-original]')) return resendOriginal();
    if (event.target.closest('[data-persist-operation]')) return repairRecord();
    if (!event.target.closest('[data-cancel-operation]') || !current) return;
    try {
      show((await request(`/api/tasks/${current.id}/cancel`, {})).operation);
    } catch (error) {
      errorPanel.textContent = error.message;
      errorPanel.hidden = false;
    }
  });
  return { action, observe, lock };
}

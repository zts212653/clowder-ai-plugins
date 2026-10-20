import { pageProjectId, projectUrl } from './project-scope.mjs';
export function createSetupFlow({ snapshot, render, action }) {
  let flow = {},
    signature,
    checking = false,
    needsCheck = false;
  const identity = () => `${snapshot()?.config?.bindingId ?? 'setup'}:${snapshot()?.connection?.revision ?? ''}`;
  const key = () => `repo-sync-setup:${pageProjectId}:${identity()}`;
  function save() {
    try {
      sessionStorage.setItem(key(), JSON.stringify(flow));
    } catch {}
  }
  function state() {
    if (signature !== identity()) {
      const sameBinding = signature?.split(':')[0] === identity().split(':')[0];
      const inputs = sameBinding ? flow.inputs : undefined;
      signature = identity();
      try {
        flow = JSON.parse(sessionStorage.getItem(key())) ?? {};
      } catch {
        flow = {};
      }
      if (inputs) flow.inputs = inputs;
      if (needsCheck) flow.editing = true;
    }
    return flow;
  }
  function change(values) {
    Object.assign(state(), values);
    save();
    render();
  }
  async function api(path) {
    const current = snapshot();
    const response = await fetch(projectUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Repo-Sync-Token': current.token },
      body: JSON.stringify({
        expectedRevision: current.connection.revision,
        ...(path === '/api/github-check' ? { expectedBinding: current.config.bindingId } : {}),
        projectId: pageProjectId,
      }),
      signal: AbortSignal.timeout(65000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`${result.code}：${result.message}`);
    return result;
  }
  async function checkConnections() {
    if (checking || !snapshot()?.config) return;
    checking = true;
    const original = identity();
    change({ editing: true, confirmed: false, checks: [] });
    const checks = state().checks;
    async function check(label, perform) {
      const row = { label, status: 'RUNNING', message: '正在只读检查…' };
      checks.push(row);
      render();
      try {
        const result = await perform();
        if (identity() !== original) return false;
        Object.assign(row, { status: 'DONE', message: '读取通过；不代表写权限已验证。' });
        save();
        render();
        return result;
      } catch (error) {
        if (identity() !== original) return false;
        Object.assign(row, { status: 'FAILED', message: error.message });
        save();
        render();
        return false;
      }
    }
    try {
      const heads = await check('Git：读取两侧仓库和分支', async () => {
        const result = await action({ action: 'heads' });
        if (!result) throw Error('连接未通过，查看下方原任务的具体失败步骤；本机配置已保存。');
        return result.result;
      });
      if (heads && identity() === original) state().heads = heads;
      let source = true,
        internal = true;
      if (snapshot().config.mode === 'continuous')
        source = await check('GitHub：来源仓库和令牌读取', () => api('/api/github-check'));
      if (snapshot().config.prTransport === 'gitlab' || snapshot().config.issueAutomation?.mode === 'gitlab')
        internal = await check('内部平台：对象接口只读验证', () => api('/api/issue-check'));
      if (identity() !== original) return;
      needsCheck = false;
      change({ editing: !(heads && source && internal), heads: state().heads });
      if (!state().editing) {
        const previous = document.querySelector('[data-setup-repositories]');
        if (previous) previous.open = false;
        const input = document.getElementById('upstream');
        input?.focus({ preventScroll: true });
        document.getElementById('baseline-step')?.scrollIntoView({ block: 'start' });
      }
    } finally {
      checking = false;
    }
  }
  function acceptReport(result) {
    if (!result?.result || result.result.bindingId !== snapshot().config?.bindingId) return;
    change({ report: result.result, confirmed: false, editing: false });
    const form = document.querySelector('[data-form="inspect-baseline"]');
    if (form) {
      form.elements.upstream.value = result.result.upstream;
      form.elements.internal.value = result.result.internal;
    }
    const target = result.result.valid
      ? document.querySelector('[data-confirm-baseline]')
      : document.getElementById('baseline-differences');
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: result.result.valid ? 'center' : 'start' });
  }
  document.addEventListener('click', (event) => {
    const target = event.target.closest('button');
    if (!target) return;

    if (target.hasAttribute('data-edit-connection')) change({ editing: true, report: null, confirmed: false });
    if (target.hasAttribute('data-check-connections')) void checkConnections();
    if (target.hasAttribute('data-edit-baseline')) change({ confirmed: false });
    if (target.hasAttribute('data-confirm-baseline') && state().report?.valid) {
      change({ confirmed: true });
      document.getElementById('baseline-step')?.scrollIntoView({ block: 'start' });
    }
  });
  document.addEventListener('input', (event) => {
    if (
      event.target.closest('[data-form="inspect-baseline"]') &&
      ['upstream', 'internal'].includes(event.target.name)
    ) {
      state().inputs ??= {};
      state().inputs[event.target.name] = event.target.value;
      save();
    }
    if (['upstream', 'internal', 'internalPaths'].includes(event.target.name) && state().report) {
      // Keep the tree for rule editing, but require rechecking before activation.
      state().report.valid = false;
      state().confirmed = false;
      save();
      document.querySelector('[data-confirm-baseline]')?.remove();
    }
  });
  return {
    state,
    checkConnections,
    acceptReport,
    beginSave: () => {
      needsCheck = true;
    },
    partial: () => change({ editing: true }),
    heads: (result) => {
      state().heads = result;
      state().inputs ??= {};
      state().inputs.internal = result.internal;
      save();
    },
  };
}

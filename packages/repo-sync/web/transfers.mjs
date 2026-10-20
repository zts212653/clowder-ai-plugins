import { snapshotIdentity } from './action-scope.mjs';
import { pageProjectId, projectUrl } from './project-scope.mjs';
import { transferBanner, transferHeld, transferView } from './transfer-view.mjs';

const limit = 128 * 1024 * 1024;
const running = (value) =>
  ['RUNNING', 'CANCELLING', 'STOP_UNCONFIRMED'].includes(value?.status) ||
  value?.persistence?.status === 'FAILED';

export function createTransfers(snapshot, refresh) {
  const local = {
    kind: 'template',
    busy: false,
    error: '',
    message: '',
    preview: null,
    name: '',
    confirmed: false,
  };
  let root, view;
  function render(content = root, currentView = view) {
    root = content;
    view = currentView;
    if (!root) return;
    root.querySelector('#transfer-settings')?.remove();
    root.querySelector('#transfer-hold')?.remove();
    const current = snapshot();
    if (view !== 'configuration') {
      root.insertAdjacentHTML('afterbegin', transferBanner(current));
      if (transferHeld(current))
        for (const element of root.querySelectorAll(
          'button[data-action], form[data-form] button, [data-preview-sync]',
        )) {
          element.disabled = true;
          element.setAttribute('data-preserve-disabled', '');
        }
      return;
    }
    if (transferHeld(current)) root.innerHTML = '';
    root.insertAdjacentHTML(transferHeld(current) ? 'afterbegin' : 'beforeend', transferView(current, local));
    lock();
  }
  function lock() {
    for (const element of document.querySelectorAll(
      '#transfer-settings button, #transfer-settings input, #transfer-settings select',
    )) {
      const guarded = element.hasAttribute('data-preserve-disabled');
      if (
        local.busy ||
        (running(snapshot()?.operation) &&
          element.matches('[data-transfer-export], [data-transfer-check], [data-transfer-activate]'))
      ) {
        if (!guarded) element.dataset.transferLocked = '';
        element.disabled = true;
        element.setAttribute('data-preserve-disabled', '');
      } else if (element.hasAttribute('data-transfer-locked')) {
        element.disabled = false;
        element.removeAttribute('data-preserve-disabled');
        delete element.dataset.transferLocked;
      }
    }
  }
  function scope(current = snapshot()) {
    return {
      expectedRevision: current.connection?.revision ?? null,
      expectedBinding: current.config?.bindingId ?? null,
      projectId: pageProjectId,
    };
  }
  function assertCurrent(identity) {
    if (identity !== snapshotIdentity(snapshot()))
      throw Error('CONFIGURATION_CHANGED：项目或同步进度已变化，请重新读取页面；旧操作没有发送到新范围。');
  }
  async function request(action, input, identity, raw = false) {
    assertCurrent(identity);
    const response = await fetch(projectUrl(`/api/transfers/${action}`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Repo-Sync-Token': snapshot().token,
      },
      body: raw ? input : JSON.stringify(input),
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) {
      const value = await response.json();
      throw Error(`${value.code ?? 'TRANSFER_FAILED'}：${value.message ?? '操作未完成，原项目保留。'}`);
    }
    return response;
  }
  async function execute(operation) {
    if (local.busy) return;
    local.busy = true;
    local.error = '';
    local.message = '';
    lock();
    try {
      await operation(snapshotIdentity(snapshot()));
    } catch (error) {
      local.error = error.message;
      local.focus ??= 'feedback';
      if (local.pendingImport && error.message.includes('CONFIGURATION_BUSY')) local.recoveryRequired = true;
    } finally {
      local.busy = false;
      render();
      focusResult();
    }
  }
  function focusResult() {
    const selectors = {
      preview: '.transfer-preview',
      checks: '.transfer-checks',
      feedback: '[data-transfer-feedback]',
    };
    const kind = local.focus,
      selector = selectors[kind];
    local.focus = null;
    if (!selector) return;
    const failed = kind === 'checks' ? root.querySelector('.transfer-check-list .bad') : null;
    const target = failed ?? root.querySelector(local.error ? '[data-transfer-feedback]' : selector);
    if (!target) return;
    for (let node = target.parentElement; node; node = node.parentElement)
      if (node.tagName === 'DETAILS') node.open = true;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'center' });
  }
  async function exportFile(identity) {
    try {
      const response = await request('export', { kind: local.kind, ...scope() }, identity);
      const blob = await response.blob(),
        url = URL.createObjectURL(blob),
        anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `repo-sync-${local.kind}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      local.message =
        local.kind === 'migration'
          ? '完整包已下载；源项目已冻结，请在新环境导入并检查。'
          : '配置模板已下载；不含同步进度和认证。';
    } finally {
      await refresh();
    }
  }
  async function previewFile(form, identity) {
    const file = form.querySelector('[data-transfer-file]').files[0];
    if (!file) throw Error('请选择配置模板或完整迁移包。');
    if (file.size > limit)
      throw Error('PACKAGE_TOO_LARGE：文件超过 128 MiB，请联系管理员使用受支持的迁移方式。');
    const result = await (await request('preview', file, identity, true)).json();
    assertCurrent(identity);
    local.preview = result.summary ?? result;
    local.name = local.preview.name ?? '';
    local.pendingImport = null;
    local.message = '文件内容已检查；尚未导入或启用。';
    local.focus = 'preview';
  }
  async function importFile(_form, identity) {
    if (!local.preview) throw Error('请先读取并检查文件。');
    local.pendingImport ??= {
      packageId: local.preview.packageId,
      name: local.name,
      expectedWorkspaceRevision: snapshot().workspace?.revision ?? null,
      projectId: pageProjectId,
    };
    const result = await (await request('import', local.pendingImport, identity)).json();
    const url = new URL(location.href);
    url.searchParams.set('project', result.project.id);
    url.searchParams.set('view', 'configuration');
    url.searchParams.delete('record');
    location.assign(url.href);
  }
  async function check(identity) {
    local.focus = 'checks';
    await request('check', scope(), identity);
    local.confirmed = false;
    await refresh();
    local.message = '检查结果已更新；失败项旁可查看原因并处理，处理后重新检查。';
  }
  async function activate(identity) {
    local.focus = 'checks';
    if (!local.confirmed) throw Error('请先确认此接收分支只有当前环境继续同步。');
    const result = await (
      await request('activate', { ...scope(), confirmSingleWriter: true }, identity)
    ).json();
    await refresh();
    if (result.activated === false) {
      local.confirmed = false;
      throw Error('迁移未启用：重新核验发现条件未满足，请处理下方失败项后重试。');
    }
    local.message = '迁移已启用；请回到工作台检查原进度后明确继续。';
  }
  async function recoverRegistration(identity) {
    if (!local.recoveryConfirmed || !local.pendingImport) throw Error('请先确认旧服务及其子进程全部退出。');
    await request(
      'recover-registration',
      { projectId: pageProjectId, confirmWritersStopped: true },
      identity,
    );
    local.recoveryRequired = false;
    local.recoveryConfirmed = false;
    local.message = '项目登记锁已恢复。请点击“重试原导入”，继续使用原包和原请求；没有重新创建 Issue 或 PR。';
  }
  function revealAuthentication(kind) {
    const panel = root.querySelector(kind === 'github' ? '#github-source-auth' : '#issue-auth');
    if (!panel) {
      local.error = '当前项目没有配置这种 API 认证。Git 认证请在运行此服务的本机配置，然后重新检查迁移条件。';
      render();
      return;
    }
    for (let node = panel; node; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true;
    panel.scrollIntoView({ block: 'center', behavior: 'smooth' });
    panel.querySelector('input[type="password"]')?.focus({ preventScroll: true });
  }
  function guardSecrets() {
    const field = [...root.querySelectorAll('input[type="password"]')].find((input) => input.value);
    if (!field) return true;
    const feedback = root.querySelector('[data-transfer-feedback]');
    feedback.textContent = '存在尚未提交的 Token，请先点击对应认证表单的“提供”按钮，再检查或启用迁移。';
    feedback.classList.add('bad');
    field.focus();
    return false;
  }
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!form.matches('[data-transfer-upload], [data-transfer-import]')) return;
    event.preventDefault();
    void execute((identity) =>
      form.matches('[data-transfer-upload]') ? previewFile(form, identity) : importFile(form, identity),
    );
  });
  document.addEventListener('change', (event) => {
    if (event.target.matches('[data-transfer-kind]')) {
      local.kind = event.target.value;
      const migration = local.kind === 'migration';
      root.querySelector('[data-transfer-export-note]').textContent = migration
        ? '包含台账、历史、SHA / Issue / PR 映射和 Git 对象。导出将冻结此源项目并暂停推进；请在当前任务结束后操作。'
        : '只包含仓库、分支、同步模式与规则；不包含已有基线、历史或同步进度。';
      root.querySelector('[data-transfer-export]').textContent = migration
        ? '冻结项目并导出完整迁移包'
        : '导出无凭据配置模板';
    }
    if (event.target.matches('[data-transfer-confirm]')) {
      local.confirmed = event.target.checked;
      const button = root.querySelector('[data-transfer-activate]'),
        checks = snapshot().transfer?.checks ?? [];
      const ready = local.confirmed && checks.length > 0 && checks.every((item) => item.status === 'PASSED');
      button.disabled = !ready;
      button.toggleAttribute('data-preserve-disabled', !ready);
      lock();
    }
    if (event.target.matches('[data-transfer-file]')) {
      local.preview = null;
      local.pendingImport = null;
      local.recoveryRequired = false;
      local.recoveryConfirmed = false;
      local.error = '';
      root.querySelector('.transfer-preview')?.remove();
    }
    if (event.target.matches('[data-transfer-recovery-confirm]')) {
      local.recoveryConfirmed = event.target.checked;
      const button = root.querySelector('[data-transfer-recover]');
      button.disabled = !local.recoveryConfirmed;
      button.toggleAttribute('data-preserve-disabled', !local.recoveryConfirmed);
      lock();
    }
  });
  document.addEventListener('input', (event) => {
    if (event.target.matches('[name="transferName"]')) local.name = event.target.value;
  });
  document.addEventListener(
    'toggle',
    (event) => {
      if (event.target.id === 'transfer-settings' && root?.contains(event.target))
        local.open = event.target.open;
    },
    true,
  );
  document.addEventListener('click', (event) => {
    const target = event.target.closest(
      '[data-transfer-export], [data-transfer-check], [data-transfer-activate], [data-transfer-auth], [data-transfer-recover]',
    );
    if (!target || !root?.contains(target)) return;
    if (target.hasAttribute('data-transfer-auth')) return revealAuthentication(target.dataset.transferAuth);
    if (!guardSecrets()) return;
    const operation = target.hasAttribute('data-transfer-recover')
      ? recoverRegistration
      : target.hasAttribute('data-transfer-export')
        ? exportFile
        : target.hasAttribute('data-transfer-check')
          ? check
          : activate;
    void execute(operation);
  });
  return { render };
}

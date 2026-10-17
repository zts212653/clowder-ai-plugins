import { githubAuthForm } from './github-auth.mjs';
import { authenticationForm } from './issue-auth.mjs';
import { esc, when } from './ui.mjs';

export function repairButton(error, context = {}) {
  if (context.historical) return '';
  const code = error?.code ?? '';
  const [kind, text] = /^(ISSUE_AUTH|ISSUE_API_REJECTED|PR_API_REJECTED|INVALID_ISSUE_TOKEN)/.test(code)
    ? ['platform', '提供 / 更新内部 Token →']
    : /^GITHUB_(AUTH|ACCESS)/.test(code)
      ? ['github', '提供 / 更新 GitHub Token →']
      : /^TRANSFER_/.test(code)
        ? ['transfer', '打开迁移设置处理 →']
        : /SSH_|HTTPS_AUTH|REPOSITORY_UNAVAILABLE|NETWORK_|COMMAND_NOT_FOUND|API_(UNAVAILABLE|TLS)/.test(code)
          ? ['connection', '查看连接设置与处理方法 →']
          : [];
  return kind
    ? `<button type="button" class="${context.primary ? 'primary' : ''}" data-repair="${kind}" data-repair-delivery="${esc(context.deliveryId ?? '')}">${text}</button>`
    : '';
}

export function recoveryDisposition(pending, current) {
  const run = current.state?.automation;
  if (!pending?.runId || pending.bindingId !== current.config?.bindingId || run?.id !== pending.runId)
    return null;
  if (current.state?.active) return null;
  if (
    run.status === 'COMPLETE' ||
    (run.status === 'PAUSED' &&
      pending.deliveryId &&
      run.pauseRequested?.afterDeliveryId === pending.deliveryId)
  )
    return 'completed';
  if (run.status === 'PAUSED' && pending.deliveryId && run.restartOf === pending.deliveryId)
    return 'cancelled';
  return null;
}

export function createRecoveryNavigation({ snapshot, changeView, action }) {
  const pageProjectId = new URL(location.href).searchParams.get('project') ?? 'default';
  const key = `repo-sync-repair:${pageProjectId}`;
  let pending = read(),
    retired = null;
  function read() {
    try {
      const value = JSON.parse(sessionStorage.getItem(key));
      return value?.schema === 1 &&
        ['platform', 'github', 'transfer', 'connection'].includes(value.kind) &&
        /^[a-f0-9]{64}$/.test(value.bindingId ?? '') &&
        (!value.runId || /^[a-f0-9]{32}$/.test(value.runId)) &&
        (!value.deliveryId || /^[a-f0-9]{24}$/.test(value.deliveryId))
        ? value
        : null;
    } catch {
      return null;
    }
  }
  function save() {
    try {
      sessionStorage.setItem(key, JSON.stringify(pending));
    } catch {
      /* In-memory repair remains usable. */
    }
  }
  function matches(current) {
    return (
      current.config?.bindingId === pending?.bindingId &&
      (current.state?.automation?.id ?? null) === pending.runId &&
      (current.state?.active?.id ?? null) === pending.deliveryId
    );
  }
  function mount(content, view) {
    content.querySelector('#recovery-return')?.remove();
    content.querySelector('#recovery-retired')?.remove();
    const disposition = recoveryDisposition(pending, snapshot());
    if (disposition) {
      retired = disposition;
      pending = null;
      try {
        sessionStorage.removeItem(key);
      } catch {}
    }
    if (view === 'configuration' && retired) {
      const notice = document.createElement('p');
      notice.id = 'recovery-retired';
      notice.setAttribute('role', 'status');
      notice.textContent =
        retired === 'completed'
          ? '原同步已完成，恢复提示已清理。'
          : '原同步已撤销，恢复提示已清理；可回工作台查看记录。';
      content.prepend(notice);
    }
    if (!pending || view !== 'configuration') return;
    const current = snapshot(),
      same = matches(current);
    const cancel = current.state?.active?.cancellation?.status === 'REQUESTED';
    const auth =
      pending.kind === 'platform'
        ? (current.config?.platformApi?.authentication ?? current.config?.issueAutomation?.authentication)
        : current.sourceAuthentication;
    const held = ['IMPORTED', 'EXPORTED'].includes(current.transfer?.status);
    const ready = pending.provided && auth?.available && same && !held;
    const message = held
      ? '项目处于迁移暂停中。请先在下方迁移设置补充认证、核验并明确启用；源环境恢复前还需确认接收端已停止。'
      : ready
        ? '新认证已保存。可以继续原轮次，系统先回读原对象，不重新发起同步。'
        : '更新认证或修复连接后，回到原步骤继续。Git 的 SSH / HTTPS 凭据需在启动此服务的系统账号下配置，API Token 不能替代。';
    const panel = document.createElement('section');
    panel.className = 'card';
    panel.id = 'recovery-return';
    panel.innerHTML = `<h3>处理后回到原同步</h3><p>${same ? '当前 PR、Issue、已完成步骤和同步进度均保留。' : '原同步状态已变化；不会恢复另一笔交付，请回到工作台核对。'}</p><div data-recovery-auth></div><p data-recovery-feedback role="status">${message}</p>${pending.kind === 'connection' && !held ? '<p>核对下方仓库和平台设置。网络或证书修复在本机完成；不要关闭证书校验。修复 Git 登录后可以重新只读检查两侧连接，再返回原步骤。</p><button type="button" data-action="heads">重新检查两侧 Git 连接</button>' : ''}<div class="task-actions">${pending.runId && ['platform', 'github'].includes(pending.kind) ? `<button type="button" data-recovery-resume ${ready ? '' : 'disabled data-preserve-disabled'}>${cancel ? '继续原 PR 撤销 →' : '继续原同步 →'}</button>` : ''}<button type="button" data-recovery-return>返回原步骤 →</button></div>`;
    content.prepend(panel);
    if (pending.kind === 'platform' && !content.querySelector('#issue-auth'))
      panel.querySelector('[data-recovery-auth]').innerHTML = authenticationForm(current.config ?? {});
    if (pending.kind === 'github' && !content.querySelector('#github-source-auth'))
      panel.querySelector('[data-recovery-auth]').innerHTML = githubAuthForm(current, { open: true });
  }
  function focus() {
    const id =
      pending.kind === 'platform'
        ? 'issue-auth'
        : pending.kind === 'github'
          ? 'github-source-auth'
          : pending.kind === 'transfer'
            ? 'transfer-settings'
            : 'recovery-return';
    const target = document.getElementById(id) ?? document.getElementById('recovery-return');
    for (let parent = target; parent; parent = parent.parentElement)
      if (parent.tagName === 'DETAILS') parent.open = true;
    target?.scrollIntoView({ block: 'center' });
    target?.querySelector('input[type="password"], input, button')?.focus({ preventScroll: true });
  }
  document.addEventListener('click', async (event) => {
    const repair = event.target.closest('[data-repair]');
    if (repair) {
      const current = snapshot();
      if (!current?.config) return;
      retired = null;
      pending = {
        schema: 1,
        kind: repair.dataset.repair,
        bindingId: current.config.bindingId,
        runId: current.state?.automation?.id ?? null,
        deliveryId: current.state?.active?.id ?? null,
        provided: false,
      };
      // A historic failure can open authentication, but must never resume the live delivery on its behalf.
      if (repair.dataset.repairDelivery && repair.dataset.repairDelivery !== pending.deliveryId)
        pending.runId = null;
      save();
      changeView('configuration');
      focus();
      return;
    }
    if (event.target.closest('[data-recovery-return]')) {
      changeView('workbench');
      return;
    }
    if (!event.target.closest('[data-recovery-resume]') || !pending || !matches(snapshot())) return;
    const current = snapshot(),
      runId = pending.runId;
    if (!pending.provided || !runId || ['IMPORTED', 'EXPORTED'].includes(current.transfer?.status)) return;
    changeView('workbench');
    await action(
      current.state?.active?.cancellation?.status === 'REQUESTED'
        ? {
            action: 'cancel-delivery',
            confirmed: true,
            deliveryId: pending.deliveryId,
            previousUrl: current.state.active.prUrl ?? '',
          }
        : { action: 'resume-sync', runId, deliveryId: pending.deliveryId },
    );
  });
  document.addEventListener('repo-sync-auth-provided', (event) => {
    if (!pending || event.detail?.kind !== pending.kind || !matches(snapshot())) return;
    pending.provided = true;
    save();
    mount(document.getElementById('content'), 'configuration');
    document.getElementById('recovery-return')?.scrollIntoView({ block: 'nearest' });
  });
  return { mount };
}

export function showActivity(task) {
  const activity = document.getElementById('current-activity');
  if (activity)
    activity.textContent =
      task && ['RUNNING', 'CANCELLING', 'STOP_UNCONFIRMED'].includes(task.status)
        ? `当前同步：${task.status} · 状态最近成功读取 ${when(task.observedAt)} · 可点击“当前同步”返回查看`
        : '';
}

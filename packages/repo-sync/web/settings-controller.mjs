import { clearFormErrors, showFormErrors } from './form-errors.mjs';
import { pageProjectId, projectUrl } from './project-scope.mjs';
import { esc } from './ui.mjs';
export function createSettingsController(snapshot, refresh) {
  let feedback = null,
    sending = false;
  function renderFeedback() {
    if (!feedback || feedback.project !== pageProjectId || feedback.binding !== snapshot().config?.bindingId)
      return;
    const area = document.querySelector('[data-settings-result]');
    if (area) area.innerHTML = feedback.html;
  }
  document.addEventListener('click', (event) => {
    const key = event.target.closest('[data-clear-secret]')?.dataset.clearSecret;
    if (key) {
      const field = document.querySelector(`[name="${key}"]`);
      if (field) field.value = '';
    }
  });
  async function submit(form) {
    if (sending) return;
    clearFormErrors(form);
    sending = true;
    const initial = snapshot(),
      binding = initial.config.bindingId;
    const fields = Object.fromEntries(new FormData(form));
    delete fields.issueToken;
    delete fields.githubToken;
    delete fields.autoMergeWaitMinutes;
    if (!fields.internalWebUrl && !initial.config.internalWebUrl && fields.prMode === 'manual')
      delete fields.internalWebUrl;
    const strategy = fields.commitStrategy;
    if (initial.config.mode === 'continuous' && fields.prMode === 'gitlab') fields.issueMode = 'gitlab';
    if (strategy) {
      fields.receivingIdentity = {
        name: fields.commitName?.trim(),
        email: fields.commitEmail?.trim(),
      };
      delete fields.commitName;
      delete fields.commitEmail;
    }
    if (fields.commitClosureVerified !== undefined)
      fields.commitClosureVerified = fields.commitClosureVerified === 'on';
    fields.autoMergeWaitMs = Number(form.elements.autoMergeWaitMinutes.value) * 60000;
    fields.workspaceRevision = initial.workspace?.revision;
    if (initial.workspace) fields.projectId = pageProjectId;
    const buttons = [...form.querySelectorAll('button')];
    for (const button of buttons) button.disabled = true;
    try {
      const response = await fetch(projectUrl('/api/project-settings'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Repo-Sync-Token': initial.token,
        },
        body: JSON.stringify(fields),
        signal: AbortSignal.timeout(90000),
      });
      const result = await response.json();
      if (!response.ok) {
        showFormErrors('configure-project-settings', result.details?.fields);
        throw Error(`${result.code}：${result.message}`);
      }
      feedback = {
        project: pageProjectId,
        binding,
        html: `<h3>${result.checks.some((c) => c.status === 'FAILED') ? '配置已保存，部分项目需处理' : '设置已保存'}</h3>${result.checks.map((c) => `<details class="tech"><summary>为什么？</summary><div class="tech-copy class="${c.status === 'FAILED' ? 'bad' : 'good'}"">${c.status === 'FAILED' ? '×' : '✓'} ${esc(c.label)}：${esc(c.error?.message ?? c.message)}</div></details>`).join('')}`,
      };
      if (snapshot().config?.bindingId !== binding) return;
      await refresh();
      renderFeedback();
      for (const [field, kind, label] of [['issueToken', 'platform', '内部认证提供'], ['githubToken', 'github', 'GitHub 认证提供']])
        if (fields[field] && result.checks.some((c) => c.label === label && c.status === 'DONE'))
          document.dispatchEvent(new CustomEvent('repo-sync-auth-provided', { detail: { kind } }));
    } catch (error) {
      feedback = {
        project: pageProjectId,
        binding,
        html: `<p class="bad">${esc(error.message)}</p><p>没有自动开始同步。回执不明时先刷新核对已保存的设置。</p>`,
      };
      renderFeedback();
    } finally {
      sending = false;
      for (const button of buttons) if (button.isConnected) button.disabled = false;
    }
  }
  return { submit, renderFeedback };
}

import { updateIssueInference } from './issue-inference.mjs';
import { esc } from './ui.mjs';

export function tokenField() {
  return '<label>内部平台 Token<input type="password" name="issueToken" autocomplete="off" placeholder="输入 Token，不回显原值"></label><p>仅供当前项目的平台 API 使用；只保留在本次服务内存，重启后需要重新输入，不保存到浏览器草稿、配置或执行记录。</p>';
}
export function authenticationForm(config) {
  const api = config.platformApi ?? config.issueAutomation;
  if (api?.mode !== 'gitlab') return '';
  const available = api.authentication?.available;
  return `<section id="issue-auth"><h4>平台认证与接口验证</h4><p>${available ? '认证已提供；仍需验证接口。' : '需要提供 Token，或恢复原环境变量。'}输入 Token 不代表平台接口已通过核验。</p><p class="credential-scope"><b>此 Token 的 API 接收地址：</b><code>${esc(api.apiUrl ?? '请先核对平台接口配置')}</code><br>平台项目：<code>${esc(api.projectId ?? '未配置')}</code>。导入的配置也会使用此地址；请核对它属于预期的内部平台，再提供认证和检查。</p><form data-secret-form="issue-token">${tokenField()}<button type="submit">提供 / 更换 Token（本次服务）</button><button type="button" data-issue-check>验证平台接口（只读）</button><button type="button" data-issue-clear>清除本次输入的 Token</button></form><p data-auth-feedback role="status"></p></section>`;
}
export function createIssueAuthentication(snapshot, refresh, errorPanel) {
  async function request(path, value, scope = snapshot()) {
    const revision = scope.connection.revision,
      csrf = scope.token;
    const { pageProjectId, projectUrl } = await import('./project-scope.mjs');
    const response = await fetch(projectUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Repo-Sync-Token': csrf },
      body: JSON.stringify({
        expectedRevision: revision,
        ...(scope.workspace ? { projectId: pageProjectId } : {}),
        ...value,
      }),
      signal: AbortSignal.timeout(35000),
    });
    const result = await response.json();
    if (!response.ok) throw Error(`${result.code}：${result.message}`);
    return result;
  }
  function take(form) {
    const field = form.elements.namedItem('issueToken'),
      value = field?.value ?? '';
    if (field) field.value = '';
    return value;
  }
  async function set(value, scope) {
    await request('/api/issue-auth', { token: value }, scope);
    await refresh();
    if (value) document.dispatchEvent(new CustomEvent('repo-sync-auth-provided', { detail: { kind: 'platform' } }));
  }
  function feedback(message) {
    const target = document.querySelector('[data-auth-feedback]');
    if (target) {
      target.textContent = message;
      for (let parent = target.parentElement; parent; parent = parent.parentElement)
        if (parent.tagName === 'DETAILS') parent.open = true;
      target.scrollIntoView({ block: 'nearest' });
    } else {
      errorPanel.textContent = message;
      errorPanel.hidden = false;
    }
  }
  async function submit(form) {
    const value = take(form);
    try {
      if (!value) throw Error('请先输入 Token；不会保存空值或覆盖原认证。');
      await set(value);
      feedback('Token 已提供，仅在本次服务内存。下一步点击只读验证，尚未创建或修改 Issue。');
    } catch (error) {
      feedback(error.message);
    }
  }
  async function provide(value, scope) {
    try {
      await set(value, scope);
      return true;
    } catch (error) {
      feedback(`配置已经保存，但 Token 提供未确认；请在当前项目重新输入。${error.message}`);
      return false;
    }
  }
  document.addEventListener('click', async (event) => {
    const provide = event.target.closest('[data-auth-provide="issue"]'),
      check = event.target.closest('[data-issue-check]'),
      clear = event.target.closest('[data-issue-clear]');
    if (!provide && !check && !clear) return;
    try {
      if (provide) {
        const panel = provide.closest('[data-auth-panel="issue"]');
        const field = panel?.querySelector('[name="issueToken"]');
        const value = field?.value ?? '';
        if (field) field.value = '';
        if (!value) throw Error('请先输入内部平台 Token；空值不会覆盖已有认证。');
        await set(value);
        feedback('✓ Token 已保存到本次服务。请点击旁边的只读验证按钮确认接口权限。');
      } else if (clear) {
        await set('');
        feedback('已清除本次输入；环境变量认证若存在仍保留。');
      } else {
        const result = await request('/api/issue-check', {});
        await refresh();
        feedback(
          `项目 API 只读核验通过；没有创建或修改 Issue / PR。${result.defaultBranch ? `平台默认分支 ${result.defaultBranch}；当前合入分支 ${snapshot().config.targetBranch}，请核对选择。` : ''}`,
        );
      }
    } catch (error) {
      feedback(error.message);
    }
  });
  document.addEventListener('change', (event) => {
    if (['issueMode', 'issueAuthMode', 'prMode', 'mode', 'commitStrategy'].includes(event.target.name))
      updateIssueFields(event.target.closest('form'));
  });
  document.addEventListener('input', (event) => {
    if (['internalWebUrl', 'issuePageUrl', 'issueApiUrl', 'issueProjectId'].includes(event.target.name))
      updateIssueInference(event.target.closest('form'));
  });
  async function complete(result, token) {
    if (!result) return false;
    if (!token) return true;
    const current = snapshot();
    if (
      result.config?.bindingId !== current.config.bindingId ||
      !result.connection?.revision ||
      result.connection.revision !== current.connection.revision
    ) {
      feedback('保存后的仓库或接口配置已变化，未向新范围提供 Token。请在当前配置重新输入。');
      return false;
    }
    return provide(token, current);
  }
  return { take, set, submit, provide, complete };
}
export function updateIssueFields(form) {
  if (!form) return;
  for (const card of form.querySelectorAll('[data-mode-card]'))
    card.setAttribute('aria-pressed', String(card.dataset.modeCard === form.elements.namedItem('mode')?.value));
  const identity = form.querySelector('[data-identity-details]');
  if (identity && form.elements.namedItem('commitStrategy')?.value === 'rewrite') identity.open = true;
  const pr = form.elements.namedItem('prMode'),
    summary = form.querySelector('[data-pr-summary]');
  if (pr && summary)
    summary.textContent = `保存后采用：${pr.selectedOptions[0].textContent}；审核合入仍在内部平台完成。`;
  const mode = form.elements.namedItem('issueMode')?.value,
    auth = form.elements.namedItem('issueAuthMode')?.value,
    version = form.elements.namedItem('mode') ? form.elements.namedItem('mode').value !== 'continuous' : false;
  const sourceAuth = form.querySelector('[data-source-auth]');
  if (sourceAuth) sourceAuth.hidden = version;
  const closure = form.querySelector('[data-closure]');
  if (closure) closure.hidden = version;
  const selection = form.querySelector('[data-issue-selection]');
  if (selection) selection.hidden = version;
  const api = form.querySelector('[data-issue-api]');
  if (api) api.hidden = form.elements.namedItem('prMode')?.value !== 'gitlab' && (version || mode !== 'gitlab');
  const platformAuth = form.querySelector('[data-platform-auth]');
  if (platformAuth)
    platformAuth.hidden = form.elements.namedItem('prMode')?.value !== 'gitlab' && mode !== 'gitlab';
  const manualPlatformNote = form.querySelector('[data-manual-platform-note]');
  if (manualPlatformNote) manualPlatformNote.hidden = !platformAuth?.hidden;
  const direct = form.querySelector('[data-issue-token]'),
    environment = form.querySelector('[data-issue-environment]');
  if (direct) direct.hidden = auth === 'environment';
  if (environment) environment.hidden = auth !== 'environment';
  updateIssueInference(form);
}

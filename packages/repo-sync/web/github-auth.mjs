export function githubAuthForm(snapshot, { open = false } = {}) {
  if (snapshot.config?.mode !== 'continuous') return '';
  const auth = snapshot.sourceAuthentication;
  return `<details class="card github-auth" id="github-source-auth" ${open && !auth?.available ? 'open' : ''}><summary>GitHub 读取认证 · ${auth?.available ? '已提供（未验证完整读取权限）' : '完整 PR / Issue 查询需要令牌'}</summary><p>代码和 tag 仍通过 Git 读取；PR、Issue 和关闭关联直接读取 GitHub API，不需要安装 gh。Git 的 SSH 密钥或代码登录不能替代 API 令牌。</p><p>公开仓库的部分元数据可匿名读取；完整关闭关联使用 GraphQL，需要来源仓库的 Pull requests、Issues、Contents 读取权限令牌。仅读取，不要求写权限。</p>${snapshot.connection ? '<form data-github-auth><label>GitHub 读取 Token<input name="githubToken" type="password" autocomplete="off" placeholder="仅供当前项目读取 GitHub，不是内部平台 Token"></label><p>只保留在本次服务内存；不回显、不保存到配置、浏览器草稿或任务。重启后重新提供；也支持启动环境中的 GH_TOKEN / GITHUB_TOKEN。</p><button type="submit">提供 GitHub 读取令牌</button><button type="button" data-github-check>只读验证 GitHub 连接</button><button type="button" data-github-clear>清除本次输入</button></form>' : '<p>此入口从私有文件载入配置；请在启动服务的环境设置 GH_TOKEN 或 GITHUB_TOKEN，或使用正式配置入口管理当前项目认证。</p>'}<p data-github-feedback role="status"></p></details>`;
}
export function createGithubAuthentication(snapshot, refresh) {
  async function request(path, payload, current = snapshot()) {
    const revision = current.connection.revision,
      binding = current.config.bindingId,
      csrf = current.token;
    const { pageProjectId, projectUrl } = await import('./project-scope.mjs');
    const response = await fetch(projectUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Repo-Sync-Token': csrf },
      body: JSON.stringify({
        expectedRevision: revision,
        expectedBinding: binding,
        ...(current.workspace ? { projectId: pageProjectId } : {}),
        ...payload,
      }),
      signal: AbortSignal.timeout(65000),
    });
    const result = await response.json();
    if (!response.ok) throw Error(`${result.code}：${result.message}`);
    return result;
  }
  function feedback(message) {    const panel = document.querySelector('#github-source-auth');
    if (!panel) return;
    for (let parent = panel; parent; parent = parent.parentElement)
      if (parent.tagName === 'DETAILS') parent.open = true;
    panel.querySelector('[data-github-feedback]').textContent = message;
    panel.querySelector('[data-github-feedback]').scrollIntoView({ block: 'nearest' });
  }
  async function verifyNow() {
    try {
      await request('/api/github-check', {});
      return true;
    } catch {
      return false;
    }
  }
  async function submit(form) {
    const token = form.elements.namedItem('githubToken').value;
    form.elements.namedItem('githubToken').value = '';
    if (!token) {
      feedback('请先输入 GitHub 读取令牌；不会清除原认证。');
      return;
    }
    try {
      await request('/api/github-auth', { token });
      const checked = await verifyNow();
      await refresh();
      document.dispatchEvent(new CustomEvent('repo-sync-auth-provided', { detail: { kind: 'github' } }));
      feedback(
        checked
          ? 'GitHub 读取令牌已提供，并通过只读验证。可以回到同步工作台继续。'
          : 'GitHub 读取令牌已提供，但只读验证未通过；请点“只读验证 GitHub 连接”查看原因后重试。',
      );
    } catch (error) {
      feedback(error.message);
    }
  }
  document.addEventListener('click', async (event) => {
    const provide = event.target.closest('[data-auth-provide="github"]'),
      clear = event.target.closest('[data-github-clear]'),
      check = event.target.closest('[data-github-check]');
    if (!provide && !clear && !check) return;
    try {
      if (provide) {
        const panel = provide.closest('[data-auth-panel="github"]');
        const field = panel?.querySelector('[name="githubToken"]');
        const token = field?.value ?? '';
        if (field) field.value = '';
        if (!token) throw Error('请先输入 GitHub 读取 Token；空值不会覆盖已有认证。');
        await request('/api/github-auth', { token });
        const checked = await verifyNow();
        await refresh();
        document.dispatchEvent(new CustomEvent('repo-sync-auth-provided', { detail: { kind: 'github' } }));
        feedback(
          checked
            ? '✓ Token 已保存到本次服务并通过只读验证。可以回到同步工作台继续。'
            : 'Token 已保存，但只读验证未通过；请点“只读验证 GitHub 连接”查看原因。',
        );
      } else if (clear) {
        await request('/api/github-auth', { token: '' });
        await refresh();
        feedback('已清除本次输入；启动环境中的令牌若存在仍可使用。');
      } else {
        await request('/api/github-check', {});
        await refresh();
        feedback(
          'GitHub 仓库与令牌只读核验通过；完整 PR / Issue 关联权限将在实际读取时继续核验，尚未创建或修改任何对象。',
        );
      }
    } catch (error) {
      feedback(error.message);
    }
  });
  function take(form) {
    const field = form.elements.namedItem('githubToken');
    const value = field?.value ?? '';
    if (field) field.value = '';
    return value;
  }
  async function complete(result, token) {
    if (!result) return false;
    if (!token) return true;
    const current = snapshot();
    if (
      result.config?.bindingId !== current.config.bindingId ||
      !result.connection?.revision ||
      result.connection.revision !== current.connection.revision
    ) {
      feedback('保存后的仓库或接口配置已变化，未向新范围提供 Token。请刷新后在当前配置重新输入。');
      return false;
    }
    try {
      await request('/api/github-auth', { token }, current);
      await refresh();
      return true;
    } catch (error) {
      feedback(`仓库配置已保存，但 GitHub Token 未确认；请重新提供。${error.message}`);
      return false;
    }
  }
  return { submit, take, complete };
}

import type { ModulePluginSettingsHost } from '@clowder-ai/plugin-sdk';
import { executeGitHubRequest, type GitHubRequestOptions } from './business/infrastructure/github/request-budget.js';

/** Read-only auth probe. It neither activates schedules nor mutates configuration. */
export function createGitHubSettings(host: Pick<ModulePluginSettingsHost, 'secrets'>, execFileAsync?: GitHubRequestOptions['execFileAsync']) {
  const lifecycle = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const probe = async (params: unknown) => {
    lifecycle.signal.throwIfAborted();
    const input = (params as { input?: Record<string, unknown> } | null)?.input;
    const value = input && Object.hasOwn(input, 'token') ? input.token : await host.secrets.get('token');
    if (value !== undefined && typeof value !== 'string') {
      return { ok: false, message: '访问令牌格式无效，请重新填写。', details: { status: 'error' } };
    }
    const token = value?.trim() || undefined;
    try {
      const { stdout } = await executeGitHubRequest(['api', 'user', '--hostname', 'github.com', '--jq', '.login'],
        { ghToken: token, signal: lifecycle.signal, timeoutMs: 10_000, ...(execFileAsync ? { execFileAsync } : {}) });
      const login = stdout.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/.test(login)) throw new Error('Invalid account response');
      return { ok: true, details: { status: 'connected', login },
        message: `已连接 GitHub（${login}），使用${token ? '插件访问令牌' : '本机 gh 登录'}。连接成功不代表已登记跟踪或具备所有仓库权限。` };
    } catch {
      // gh diagnostics can contain secrets or private repository information.
      return { ok: false, details: { status: 'error' }, message: token
        ? '连接失败，请检查访问令牌、有效期和网络；保存后再启用插件。'
        : '连接失败，请在运行 Clowder AI 的机器上登录 GitHub CLI，或填写访问令牌后重试。' };
    }
  };
  return { actions: {
    'github.connection.test': async (params: unknown) => {
      const work = probe(params);
      pending.add(work);
      try { return await work; } finally { pending.delete(work); }
    },
  }, dispose: async () => {
    lifecycle.abort(new Error('GitHub settings disposed'));
    await Promise.allSettled([...pending]);
  } };
}

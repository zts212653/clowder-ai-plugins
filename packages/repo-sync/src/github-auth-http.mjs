import { fail } from './config.mjs';
import { api, graphql, withGithub } from './gh-api.mjs';
import { githubRepository } from './github.mjs';
import { markGithubVerified, setGithubToken } from './github-auth.mjs';
import { body, requireToken, send } from './http.mjs';
import { configurationLock } from './private-config.mjs';
import { checkProjectInput } from './server-projects.mjs';

export async function githubAuthRequest(request, response, path, context, token, owner) {
  if (!['/api/github-auth', '/api/github-check'].includes(path)) return false;
  requireToken(request, token);
  if (request.method !== 'POST') {
    send(response, 404, { code: 'NOT_FOUND' });
    return true;
  }
  const input = await body(request);
  checkProjectInput(input, context.options.projectId);
  const connection = context.options.connection;
  if (!connection) fail('CONFIGURATION_REQUIRED', '请使用正式配置入口管理当前项目的 GitHub 读取认证。');
  await configurationLock(connection.describe().configurationFile, async () => {
    if (context.tasks.busy()) fail('OPERATION_RUNNING', '原任务正在执行，请等待结束后再更换 GitHub 读取认证。');
    const receiver = await connection.current();
    if (
      !receiver ||
      input.expectedRevision !== connection.describe().revision ||
      input.expectedBinding !== receiver.config.bindingId ||
      Object.keys(input).some((key) => !['token', 'expectedRevision', 'expectedBinding', 'projectId'].includes(key))
    )
      fail('CONFIGURATION_CHANGED', '仓库或配置已变化，请回到原项目重新提供 GitHub 读取认证。');
    if (path === '/api/github-auth')
      return send(response, 200, { authentication: setGithubToken(receiver.config, input.token, owner) });
    if (input.token !== undefined) fail('GITHUB_AUTH_INVALID', '只读验证不能夹带令牌，请先在认证入口提供。');
    const name = githubRepository(receiver.config.sourceUrl);
    await withGithub(receiver.config, async () => {
      const repository = await api(`repos/${name}`);
      if (repository.full_name?.toLowerCase() !== name.toLowerCase() || !repository.node_id)
        fail('METADATA_INCOMPLETE', 'GitHub API 响应与来源仓库不一致，未采用。');
      await graphql('query{viewer{login}}', {});
    });
    send(response, 200, {
      authentication: markGithubVerified(receiver.config),
      verified: true,
      scope: 'repository-read-only',
    });
  });
  return true;
}

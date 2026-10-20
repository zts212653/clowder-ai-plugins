import { fail } from './config.mjs';
import { safeError } from './execution.mjs';
import { api, graphql, withGithub } from './gh-api.mjs';
import { githubRepository } from './github.mjs';
import { setGithubToken } from './github-auth.mjs';
import { gitlabApi } from './gitlab-api.mjs';
import { body, requireToken, send } from './http.mjs';
import { apiSettings, setIssueToken } from './issue-auth.mjs';
import { checkProjectInput } from './server-projects.mjs';

export async function projectSettingsRequest(request, response, path, context, token, owner) {
  if (path !== '/api/project-settings') return false;
  requireToken(request, token);
  if (request.method !== 'POST') {
    send(response, 404, { code: 'NOT_FOUND' });
    return true;
  }
  const input = await body(request);
  checkProjectInput(input, context.options.projectId);
  const connection = context.options.connection;
  if (!connection || context.tasks.busy())
    fail('OPERATION_RUNNING', '请等当前写入结束后保存设置，原任务保留');
  const { githubToken, issueToken, projectName, workspaceRevision, ...settings } = input;
  for (const secret of [githubToken, issueToken])
    if (secret !== undefined && (typeof secret !== 'string' || secret.length > 10000))
      fail('INVALID_CONFIGURATION_INPUT', '认证输入格式无效');
  // Secrets are never passed to connection.run or Tasks.
  const receiver = await connection.run({
    ...settings,
    action: 'configure-project-settings',
  });
  const checks = [{ label: '非敏感配置', status: 'DONE', message: '设置已保存' }];
  async function check(label, action) {
    try {
      await action();
      checks.push({ label, status: 'DONE', message: '操作已确认' });
      return true;
    } catch (error) {
      checks.push({ label, status: 'FAILED', error: safeError(error) });
      return false;
    }
  }
  const sourceProvided = githubToken
    ? await check('GitHub 认证提供', () => setGithubToken(receiver.config, githubToken, owner))
    : false;
  if (issueToken) await check('内部认证提供', () => setIssueToken(receiver.config, issueToken, owner));
  if (projectName !== undefined && context.options.projects)
    await check('项目名称', () =>
      context.options.projects.rename({
        id: context.options.projectId ?? 'default',
        name: projectName,
        expectedRevision: workspaceRevision,
      }),
    );
  if (apiSettings(receiver.config))
    await check('内部平台认证', async () => {
      const project = await gitlabApi(receiver.config, apiSettings(receiver.config)).request('');
      if (project?.web_url?.replace(/\/$/, '') !== receiver.config.internalWebUrl)
        fail('ISSUE_API_UNSUPPORTED', '平台返回的项目与当前仓库不符');
    });
  if (receiver.config.mode === 'continuous' && sourceProvided)
    await check('GitHub 读取认证', () =>
      withGithub(receiver.config, async () => {
        const repo = githubRepository(receiver.config.sourceUrl);
        const value = await api(`repos/${repo}`);
        if (value.full_name?.toLowerCase() !== repo.toLowerCase())
          fail('METADATA_INCOMPLETE', 'GitHub 仓库身份不符');
        await graphql('query{viewer{login}}', {});
      }),
    );
  send(response, 200, {
    saved: true,
    checks,
    revision: connection.describe().revision,
  });
  return true;
}

import { fail } from './config.mjs';
import { gitlabApi } from './gitlab-api.mjs';
import { body, requireToken, send } from './http.mjs';
import { apiSettings, markIssueVerified, setIssueToken } from './issue-auth.mjs';
import { configurationLock } from './private-config.mjs';
import { checkProjectInput } from './server-projects.mjs';

export async function issueAuthRequest(request, response, path, context, token, owner) {
  if (!['/api/issue-auth', '/api/issue-check'].includes(path)) return false;
  requireToken(request, token);
  if (request.method !== 'POST') {
    send(response, 404, { code: 'NOT_FOUND' });
    return true;
  }
  const input = await body(request);
  checkProjectInput(input, context.options.projectId);
  const connection = context.options.connection;
  if (!connection) fail('CONFIGURATION_REQUIRED', '请使用正式配置入口设置当前项目。');
  await configurationLock(connection.describe().configurationFile, async () => {
    if (context.tasks.busy()) fail('OPERATION_RUNNING', '当前项目正在执行，请等待原任务结束再更新认证。');
    const receiver = await connection.current();
    if (
      !receiver ||
      input.expectedRevision !== connection.describe().revision ||
      Object.keys(input).some((k) => !['token', 'expectedRevision', 'projectId'].includes(k))
    )
      fail('CONFIGURATION_CHANGED', 'Issue 配置已变化，请刷新后在原项目重新输入。');
    if (path === '/api/issue-auth')
      return send(response, 200, { authentication: setIssueToken(receiver.config, input.token, owner) });
    if (input.token !== undefined) fail('INVALID_ISSUE_INPUT', '接口验证不能夹带 Token，请先在认证入口提供。');
    if (!apiSettings(receiver.config))
      fail('ISSUE_API_UNSUPPORTED', '当前平台尚无匹配的内置接口；网页链接不等于 API，不能宣称已连接。');
    const project = await gitlabApi(receiver.config, apiSettings(receiver.config)).request('');
    if (
      !project ||
      typeof project.id !== 'number' ||
      project.web_url?.replace(/\/$/, '') !== receiver.config.internalWebUrl.replace(/\/$/, '')
    )
      fail('ISSUE_API_UNSUPPORTED', '接口响应与所配仓库不匹配；请核对平台协议和高级地址，未创建或修改任何 Issue。');
    send(response, 200, {
      authentication: markIssueVerified(receiver.config),
      verified: true,
      scope: 'project-read-only',
      projectId: String(project.id),
      defaultBranch: project.default_branch,
    });
  });
  return true;
}

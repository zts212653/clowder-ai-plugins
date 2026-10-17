import { validateGitlabApi } from './api-configuration.mjs';
import { fail, objectUrl } from './config.mjs';
import { gitlabIssue } from './gitlab-issues.mjs';
import { authenticationStatus } from './issue-auth.mjs';
import { command } from './process.mjs';

export { validateGitlabApi } from './api-configuration.mjs';

export function validateIssueConfig(config) {
  const value = config.issues;
  if (value === undefined) return;
  if (!value || !['command', 'gitlab'].includes(value.mode))
    fail('INVALID_ISSUE_CONFIG', 'Issue 自动化需要 command 或 gitlab 适配方式');
  if (!config.internalWebUrl) fail('INVALID_ISSUE_CONFIG', 'Issue 自动化需要内部仓库网页地址，用于核验回执归属');
  objectUrl(config.internalWebUrl);
  if (value.mode === 'command') validateIssueCommand(value);
  else validateGitlabApi(config, value);
  if (
    value.timeoutMs !== undefined &&
    (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 300000)
  )
    fail('INVALID_ISSUE_CONFIG', 'Issue 适配器超时需为 1000～300000 毫秒');
}
export async function invokeIssue(config, request) {
  const adapter = config.issues;
  if (!adapter) fail('ISSUE_AUTOMATION_REQUIRED', '请在仓库设置配置 Issue 自动化接口；Git 本身没有通用 Issue 创建指令');
  if (adapter.mode === 'gitlab') return gitlabIssue(config, request);
  let result;
  try {
    result = JSON.parse(
      await command(adapter.command, adapter.args, {
        input: JSON.stringify({ schema: 1, ...request }),
        timeout: adapter.timeoutMs ?? 30000,
      }),
    );
  } catch {
    fail(
      'ISSUE_ADAPTER_UNAVAILABLE',
      'Issue 适配器未返回有效回执；请检查本机适配器权限与配置，再回读原对象，不重复创建',
    );
  }
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    result.schema !== 1 ||
    !Object.hasOwn(result, 'issue')
  )
    fail('ISSUE_RESPONSE_INVALID', 'Issue 适配器响应需要 schema:1 与 issue 字段');
  return result.issue;
}
export function verifyIssue(config, request, issue, allowMissing = false) {
  if (issue === null && allowMissing) return null;
  if (!issue) fail('ISSUE_OBJECT_MISSING', '原内部 Issue 未查到；保留原映射，请核对平台权限、删除或服务可用性');
  const repository = new URL(config.internalWebUrl);
  let url;
  try {
    url = new URL(objectUrl(issue.url));
  } catch {
    fail('ISSUE_RESPONSE_INVALID', 'Issue 回执链接无效');
  }
  if (
    issue.sourceId !== request.sourceId ||
    issue.key !== request.key ||
    !/^[\w-]+$/.test(issue.internalId ?? '') ||
    (request.internalId && issue.internalId !== request.internalId) ||
    url.origin !== repository.origin ||
    !url.pathname.startsWith(`${repository.pathname.replace(/\/$/, '')}/`) ||
    !['open', 'closed'].includes(issue.state) ||
    !Array.isArray(issue.links)
  )
    fail('ISSUE_IDENTITY_CONFLICT', 'Issue 回执的来源、内部编号、仓库或状态不一致；停止操作并保留原记录');
  verifyLinks(issue.links);
  return {
    sourceId: issue.sourceId,
    key: issue.key,
    internalId: issue.internalId,
    url: issue.url,
    state: issue.state,
    links: issue.links.map(({ url, head, branch, targetBranch }) => ({ url, head, branch, targetBranch })),
  };
}

export function publicIssues(config) {
  const value = config?.issues;
  return value
    ? {
        mode: value.mode,
        automatic: true,
        ...(value.mode === 'gitlab'
          ? {
              apiUrl: value.apiUrl,
              projectId: String(value.projectId),
              tokenEnv: value.tokenEnv,
              authMode: value.authMode ?? 'environment',
              authentication: authenticationStatus(config),
            }
          : {}),
      }
    : { mode: 'manual', automatic: false };
}

function validateIssueCommand(value) {
  if (
    typeof value.command !== 'string' ||
    !value.command ||
    !Array.isArray(value.args) ||
    value.args.some((arg) => typeof arg !== 'string')
  )
    fail('INVALID_ISSUE_CONFIG', 'Issue 适配器需要私有配置中的固定 executable 与 args');
}
function verifyLinks(links) {
  if (
    links.some(
      (link) =>
        !link ||
        typeof link.url !== 'string' ||
        typeof link.head !== 'string' ||
        typeof link.branch !== 'string' ||
        typeof link.targetBranch !== 'string',
    )
  )
    fail('ISSUE_RESPONSE_INVALID', 'Issue 关联回执缺少完整 PR 身份，未采用');
}

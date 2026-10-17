import { fail, objectUrl } from './config.mjs';
import { configurationErrors } from './configuration-errors.mjs';

export function issueConfiguration(config, input) {
  if (input.issueMode === undefined) return config?.issues;
  if (input.issueMode === 'manual') return undefined;
  if (input.issueMode === 'command' && config?.issues?.mode === 'command') return config.issues;
  if (input.issueMode === 'gitlab') {
    return apiConfiguration(config, input);
  }
  configurationErrors([['issueMode', 'mode']]);
}
export const issueInputKeys = [
  'issueMode',
  'issueApiUrl',
  'issueProjectId',
  'issueTokenEnv',
  'issuePageUrl',
  'issueAuthMode',
];
export const apiInputKeys = issueInputKeys.filter((key) => key !== 'issueMode');
export function repositoryWebFromIssue(page) {
  if (!page) return undefined;
  const value = objectUrl(page.trim());
  const url = new URL(value);
  const path = url.pathname.replace(/\/(?:-\/)?issues(?:\/\d+)?\/?$/, '');
  if (!path || path === url.pathname) configurationErrors([['issuePageUrl', 'url']]);
  return `${url.origin}${path}`;
}
export function apiConfiguration(config, input) {
  if (input.issueAuthMode !== undefined && !['session', 'environment'].includes(input.issueAuthMode))
    configurationErrors([['issueAuthMode', 'mode']]);
  const page =
    input.issuePageUrl ||
    (!input.issueProjectId && config?.internalWebUrl ? `${config.internalWebUrl.replace(/\/$/, '')}/issues` : null);
  const inferred = issueCoordinates(page, config?.internalWebUrl),
    previous =
      config?.issues?.mode === 'gitlab'
        ? config.issues
        : config?.pullRequests?.mode === 'gitlab'
          ? config.pullRequests
          : null;
  return {
    mode: 'gitlab',
    apiUrl: setting(input.issueApiUrl, inferred?.apiUrl, previous?.apiUrl),
    projectId: setting(input.issueProjectId, inferred?.projectId, previous?.projectId),
    ...((input.issueAuthMode ?? previous?.authMode) === 'session'
      ? { authMode: 'session' }
      : { tokenEnv: input.issueTokenEnv?.trim() || previous?.tokenEnv }),
  };
}
function setting(input, inferred, previous) {
  return input === undefined ? (previous ?? inferred) : input?.trim() || inferred;
}
function issueCoordinates(page, web) {
  if (!page) return null;
  let url, repository;
  try {
    repository = new URL(objectUrl(web));
  } catch {
    configurationErrors([['internalWebUrl', 'url']]);
  }
  try {
    url = new URL(objectUrl(page.trim()));
  } catch {
    configurationErrors([['issuePageUrl', 'url']]);
  }
  const project = url.pathname.replace(/\/(?:-\/)?issues(?:\/\d+)?\/?$/, '');
  if (
    project === url.pathname ||
    url.origin !== repository.origin ||
    project !== repository.pathname.replace(/\/$/, '')
  )
    configurationErrors([['issuePageUrl', 'repository']], 'ISSUE_API_UNSUPPORTED');
  return { apiUrl: `${url.origin}/api/v4`, projectId: project.replace(/^\//, '') };
}
export function checkIssueSettings(state, previous, next) {
  if (
    state?.issueAdapterId &&
    (JSON.stringify(previous.issues) !== JSON.stringify(next.issues) || previous.internalWebUrl !== next.internalWebUrl)
  )
    fail('ISSUE_CONFIG_FROZEN', '已有 Issue 创建意图，不能切换适配器或仓库；恢复原配置后继续');
}

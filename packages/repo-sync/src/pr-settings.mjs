import { fail } from './config.mjs';
import { apiSettings, authenticationStatus } from './issue-auth.mjs';
import { apiConfiguration, apiInputKeys } from './issue-settings.mjs';
import { prUrl } from './pull-requests.mjs';
export function prConfiguration(config, mode, input = {}) {
  if (mode === undefined) return config?.pullRequests;
  if (mode === 'manual') return undefined;
  if (mode === 'git') return config?.pullRequests?.mode === 'git' ? { ...config.pullRequests } : { mode: 'git' };
  if (mode === 'command' && config?.pullRequests?.mode === 'command') return config.pullRequests;
  if (mode === 'gitlab') return apiConfiguration(config, input);
  fail('INVALID_PR_ADAPTER', '请选择 Git 自动创建或明确手工创建；命令适配器需先在私有配置接入');
}
export function checkPlatformInput(input, receiver, revision) {
  if (
    Object.keys(input).some(
      (key) => !['action', 'expectedRevision', 'internalWebUrl', 'prMode', ...apiInputKeys].includes(key),
    )
  )
    fail('INVALID_CONFIGURATION_INPUT', '平台设置仅接受创建方式与网页仓库地址，不能提交命令');
  if (!receiver || input.expectedRevision !== revision)
    fail('CONFIGURATION_CHANGED', '配置已变化或尚未创建，请刷新核对');
  if (!['git', 'manual', 'command', 'gitlab'].includes(input.prMode)) fail('INVALID_PR_ADAPTER', '请选择 PR 创建方式');
}
export function checkFrozenPr(active, previous, next, state = null) {
  const runActive = ['RUNNING', 'WAITING_REVIEW', 'PAUSED', 'FAILED'].includes(state?.automation?.status);
  const roundLocked = Boolean(active || state?.queue?.length || runActive);
  if (!roundLocked) return;
  if (!active?.gitPr && !active?.prCreation && !active?.prUrl && !active?.candidate && !state?.queue?.length && !runActive)
    return;
  const sameDriver = JSON.stringify(next.pullRequests ?? null) === JSON.stringify(previous.pullRequests ?? null);
  if (active && !previous.internalWebUrl && next.internalWebUrl && sameDriver && !active.gitPr && !active.prCreation) {
    if (active.prUrl) prUrl(next, active.prUrl);
    return;
  }
  if (next.internalWebUrl !== previous.internalWebUrl || !sameDriver)
    fail(
      'PR_CONFIG_FROZEN',
      roundLocked && !active
        ? '当前同步轮次尚未结束，PR 创建方式和平台接口保持不变；完成本轮后可修改'
        : '当前交付已关联或发起 PR，不能更换创建配置；先核对原交付，不覆盖台账',
    );
}
export function publicPlatform(receiver) {
  const config = receiver?.config;
  return {
    prMode: config?.pullRequests ? 'automatic' : 'manual',
    transport: config?.pullRequests?.mode ?? 'manual',
    repositoryUrl: config?.internalWebUrl ?? null,
    api: publicApi(config),
  };
}
export function publicApi(config) {
  const value = config && apiSettings(config);
  return value
    ? {
        mode: 'gitlab',
        apiUrl: value.apiUrl,
        projectId: String(value.projectId),
        authMode: value.authMode ?? 'environment',
        tokenEnv: value.tokenEnv,
        authentication: authenticationStatus(config),
      }
    : null;
}

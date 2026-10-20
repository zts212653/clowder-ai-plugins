import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { commitPolicy } from './commit-policy.mjs';
import { validateIssueConfig } from './issue-adapter.mjs';
import { versionPolicy } from './policy.mjs';
import { validatePrConfig } from './pull-requests.mjs';

export function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.safeToDisplay = true;
  if (details) error.details = details;
  throw error;
}
export function safeUrl(value, local = false) {
  if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) fail('INVALID_URL', '仓库地址无效');
  if (local && isAbsolute(value)) return resolve(value);
  if (/^git@[\w.-]+:[\w./-]+(?:\.git)?$/.test(value)) return value;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('INVALID_URL', '需要 HTTPS 或 SSH Git 地址');
  }
  if (
    !['https:', 'ssh:'].includes(parsed.protocol) ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol === 'https:' && parsed.username)
  )
    fail('INVALID_URL', '地址不可含凭据、查询参数或片段');
  return value;
}
export function objectUrl(value) {
  const parsed = new URL(safeUrl(value));
  if (parsed.protocol !== 'https:') fail('INVALID_OBJECT_URL', '平台对象链接需要 HTTPS');
  return value;
}
export function validateConfig(input) {
  const config = structuredClone(input);
  validateMode(config);
  if (
    config.autoMergeWaitMs !== undefined &&
    (!Number.isInteger(config.autoMergeWaitMs) ||
      config.autoMergeWaitMs < 1000 ||
      config.autoMergeWaitMs > 86400000)
  )
    fail('INVALID_AUTO_MERGE', '自动合入等待时限需要在 1 秒至 24 小时之间');
  commitPolicy(config);
  config.sourceUrl = safeUrl(config.sourceUrl, config.allowLocal === true);
  config.internalUrl = safeUrl(config.internalUrl, config.allowLocal === true);
  for (const branch of [config.sourceBranch, config.targetBranch]) {
    if (
      typeof branch !== 'string' ||
      !/^[\w][\w./-]*$/.test(branch) ||
      branch.includes('..') ||
      branch.endsWith('/') ||
      branch.endsWith('.lock')
    )
      fail('INVALID_BRANCH', '分支名称无效');
  }
  if (!isAbsolute(config.stateDir)) fail('INVALID_STATE_DIR', '台账目录需要绝对路径，放在核心仓之外');
  config.stateDir = resolve(config.stateDir);
  if (config.sourceUrl === config.internalUrl)
    fail('SAME_REPOSITORY', '外部来源与内部接收不能使用同一个仓库地址');
  if (config.commitClosureVerified !== undefined && typeof config.commitClosureVerified !== 'boolean')
    fail('INVALID_CAPABILITY', '关单验证声明必须是布尔值');
  checkStateLocation(config);
  config.bindingId = createHash('sha256')
    .update(
      JSON.stringify([
        config.sourceUrl,
        config.internalUrl,
        config.sourceBranch,
        config.targetBranch,
        ...bindingPolicy(config),
      ]),
    )
    .digest('hex');
  for (const check of config.checks ?? []) {
    if (
      typeof check.command !== 'string' ||
      !check.command ||
      !Array.isArray(check.args) ||
      !check.args.every((arg) => typeof arg === 'string')
    )
      fail('INVALID_CHECK', '检查命令需要 executable 与字符串 args 数组');
  }
  normalizeCheckProfile(config);
  validateTimeouts(config.timeouts);
  validatePrConfig(config);
  validateIssueConfig(config);
  if (
    config.issues?.mode === 'gitlab' &&
    config.pullRequests?.mode === 'gitlab' &&
    ['apiUrl', 'projectId', 'authMode', 'tokenEnv'].some(
      (key) => String(config.issues[key] ?? '') !== String(config.pullRequests[key] ?? ''),
    )
  )
    fail(
      'PLATFORM_API_SCOPE_CONFLICT',
      'Issue 与 PR 的内置 API 必须使用同一个平台项目和认证设置，请在当前仓库统一核对。',
    );
  return config;
}
function validateTimeouts(values) {
  if (
    values !== undefined &&
    (!values ||
      typeof values !== 'object' ||
      Array.isArray(values) ||
      Object.keys(values).some((key) => !['probe', 'fetch'].includes(key)))
  )
    fail('INVALID_TIMEOUT', '超时配置只支持 probe 和 fetch');
  for (const [name, defaultValue] of Object.entries({
    probe: 20000,
    fetch: 600000,
  })) {
    const value = values?.[name] ?? defaultValue;
    if (!Number.isInteger(value) || value < 1000 || value > 3600000)
      fail('INVALID_TIMEOUT', '连接和下载超时必须是 1000～3600000 毫秒的整数');
  }
}
function normalizeCheckProfile(config) {
  if (config.checkProfile !== 'git-integrity') return;
  if (JSON.stringify(config.checks) !== JSON.stringify([{ command: 'git', args: ['fsck', '--no-reflogs'] }]))
    config.checkProfile = 'custom';
}
function validateMode(config) {
  config.mode ??= 'continuous';
  if (!['continuous', 'version'].includes(config.mode))
    fail('INVALID_MODE', '同步模式需要 continuous 或 version');
  Object.assign(config, versionPolicy(config));
}
function checkStateLocation(config) {
  for (const repository of [config.sourceUrl, config.internalUrl].filter(isAbsolute)) {
    const path = relative(repository, config.stateDir);
    if (!path || (!path.startsWith(`..${sep}`) && !isAbsolute(path)))
      fail('STATE_INSIDE_CORE', '台账目录不可放在核心仓之内');
  }
}

function bindingPolicy(config) {
  if (config.mode === 'version') return [config.mode, config.internalPaths, config.mergePaths];
  return config.internalPaths?.length ? ['continuous', config.internalPaths] : [];
}

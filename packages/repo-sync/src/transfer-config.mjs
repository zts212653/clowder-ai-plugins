import { resolve } from 'node:path';
import { fail, validateConfig } from './config.mjs';
import { defaultPushOptions } from './git-pr.mjs';

const fields = [
  'sourceUrl',
  'internalUrl',
  'internalWebUrl',
  'sourceBranch',
  'targetBranch',
  'mode',
  'internalPaths',
  'mergePaths',
  'checks',
  'checkProfile',
  'commitClosureVerified',
  'commitStrategy',
  'receivingIdentity',
  'issues',
  'pullRequests',
  'timeouts',
  'autoMergeWaitMs',
  'allowLocal',
];
const apiFields = ['mode', 'apiUrl', 'projectId', 'authMode', 'tokenEnv', 'timeoutMs'];
export function portableConfig(input, exported = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    fail('TRANSFER_CONFIG_INVALID', '迁移配置需要有效对象。');
  const permitted = exported ? fields : [...fields, 'stateDir', 'bindingId', 'configurationSource'];
  if (Object.keys(input).some((key) => !permitted.includes(key)))
    fail('TRANSFER_CONFIG_UNKNOWN', '配置含未识别字段，可能包含私有认证；请先核对并移除再导出。');
  if (
    input.checks?.length &&
    JSON.stringify(input.checks) !== JSON.stringify([{ command: 'git', args: ['fsck', '--no-reflogs'] }])
  )
    fail(
      'TRANSFER_CUSTOM_COMMAND',
      '自定义检查命令不能自动迁移；请先使用内置 Git 完整性检查，原检查未被替换。',
    );
  for (const [key, value] of Object.entries({
    issues: input.issues,
    pullRequests: input.pullRequests,
  })) {
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      fail('TRANSFER_CONFIG_INVALID', '平台适配设置不是有效对象。');
    if (value.mode === 'command')
      fail('TRANSFER_CUSTOM_COMMAND', '自定义平台命令不能自动迁移；请在原环境核对受信任适配器。');
    const allowed = key === 'pullRequests' && value.mode === 'git' ? ['mode', 'pushOptions'] : apiFields;
    if (Object.keys(value).some((field) => !allowed.includes(field)))
      fail('TRANSFER_CONFIG_UNKNOWN', '平台配置含未知字段，未导出可能包含凭据的内容。');
    if (
      value.mode === 'git' &&
      value.pushOptions !== undefined &&
      JSON.stringify(value.pushOptions) !== JSON.stringify(defaultPushOptions)
    )
      fail('TRANSFER_CUSTOM_COMMAND', '自定义 Git 推送选项不能自动迁移；原设置未被弱化或执行。');
  }
  if (
    input.receivingIdentity &&
    Object.keys(input.receivingIdentity).some((key) => !['name', 'email'].includes(key))
  )
    fail('TRANSFER_CONFIG_UNKNOWN', '提交身份设置含未知字段，未导出。');
  const config = Object.fromEntries(
    fields.filter((key) => input[key] !== undefined).map((key) => [key, structuredClone(input[key])]),
  );
  const checked = validateConfig({
    ...config,
    stateDir: resolve(process.cwd(), '.transfer-validation-state'),
  });
  if (input.bindingId !== undefined && input.bindingId !== checked.bindingId)
    fail('TRANSFER_BINDING_MISMATCH', '导出配置与原仓库绑定不一致，停止迁移。');
  return config;
}

export function transferredConfig(config, stateDir) {
  return validateConfig({
    ...portableConfig(config, true),
    stateDir,
    configurationSource: 'workbench',
  });
}

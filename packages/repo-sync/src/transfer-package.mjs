import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fail } from './config.mjs';
import { portableConfig, transferredConfig } from './transfer-config.mjs';
import { exportFiles, restoreFiles, validateFiles } from './transfer-codec-files.mjs';
import { exportObjects, noSymlinks, requiredCommits, restoreObjects, validateObjects } from './transfer-objects.mjs';

export const transferProductVersion = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
export const transferLimit = 128 * 1024 * 1024;
const fields = [
  'format',
  'schema',
  'productVersion',
  'kind',
  'createdAt',
  'project',
  'config',
  'files',
  'objects',
  'packageId',
];
function canonical(value, depth = 0) {
  if (depth > 80) fail('TRANSFER_INVALID', '迁移内容嵌套过深。');
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`)
      .join(',')}}`;
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value)))
    fail('TRANSFER_INVALID', '迁移内容不是有效 JSON。');
  return JSON.stringify(value);
}
export function transferDigest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function identity(pkg) {
  const { packageId: _packageId, ...content } = pkg;
  return transferDigest(content);
}
export async function createTransfer(receiver, { kind, projectId = 'default', name }) {
  if (!['template', 'migration'].includes(kind)) fail('TRANSFER_KIND_INVALID', '请选择配置模板或完整迁移包。');
  const config = portableConfig(receiver.config);
  const files = kind === 'migration' ? await exportFiles(receiver.config) : [];
  validateFiles(files, receiver.config, kind);
  const pkg = {
    format: 'clowder-repo-sync-transfer',
    schema: 1,
    productVersion: transferProductVersion,
    kind,
    createdAt: new Date().toISOString(),
    project: { id: projectId, name },
    config,
    files,
    objects: kind === 'migration' ? await exportObjects(receiver.config, requiredCommits(files)) : null,
  };
  pkg.packageId = identity(pkg);
  return validateTransfer(pkg);
}
export function validateTransfer(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key)) ||
    value.format !== 'clowder-repo-sync-transfer' ||
    value.schema !== 1 ||
    !['template', 'migration'].includes(value.kind) ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !/^[a-f0-9]{64}$/.test(value.packageId ?? '')
  )
    fail('TRANSFER_INVALID', '不是支持的仓库同步迁移包，原有项目未更改。');
  if (value.productVersion !== transferProductVersion)
    fail('TRANSFER_VERSION_MISMATCH', '迁移包与当前插件版本不同，请安装与导出端完全一致的版本后重试。');
  if (Buffer.byteLength(JSON.stringify(value)) > transferLimit)
    fail('TRANSFER_TOO_LARGE', '迁移包超过 128 MiB 网页导入限制。');
  if (
    !value.project ||
    Object.keys(value.project).some((key) => !['id', 'name'].includes(key)) ||
    (value.project.id !== 'default' && !/^[a-f0-9]{24}$/.test(value.project.id ?? '')) ||
    typeof value.project.name !== 'string' ||
    !value.project.name.trim() ||
    value.project.name.length > 80 ||
    /[\r\n\0]/.test(value.project.name)
  )
    fail('TRANSFER_PROJECT_INVALID', '迁移项目身份或名称无效。');
  const config = transferredConfig(value.config, resolve(process.cwd(), '.transfer-validation-state'));
  validateFiles(value.files, config, value.kind);
  if (value.kind === 'migration') validateObjects(value.objects);
  else if (value.objects !== null) fail('TRANSFER_OBJECT_INVALID', '配置模板不能携带代码对象。');
  if (identity(value) !== value.packageId)
    fail('TRANSFER_DIGEST_MISMATCH', '迁移包完整性摘要不匹配，文件可能被修改或截断。');
  return structuredClone(value);
}
export async function restoreTransfer(input, stateDir, { projectId } = {}) {
  const pkg = validateTransfer(input);
  if (!isAbsolute(stateDir)) fail('TRANSFER_PATH_INVALID', '导入暂存目录需要本机绝对路径。');
  if (projectId !== undefined && projectId !== 'default' && !/^[a-f0-9]{24}$/.test(projectId))
    fail('TRANSFER_PROJECT_INVALID', '接收项目身份无效。');
  await noSymlinks(stateDir);
  const config = transferredConfig(pkg.config, stateDir);
  try {
    await mkdir(stateDir, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') fail('TRANSFER_PATH_EXISTS', '导入目录已经存在；不能覆盖历史、映射或其他迁移。');
    throw error;
  }
  await restoreFiles(pkg, config, projectId);
  if (pkg.objects) await restoreObjects(pkg.objects, config, requiredCommits(pkg.files));
  return { config, stateDir: config.stateDir, provenance: { packageId: pkg.packageId, projectId: pkg.project.id } };
}
export function packageSummary(input) {
  const pkg = validateTransfer(input);
  const config = transferredConfig(pkg.config, resolve(process.cwd(), '.transfer-validation-state'));
  const ledger = pkg.files.find((file) => file.path === 'ledger.json');
  const state = ledger ? JSON.parse(ledger.content) : null;
  const active = state?.deliveries.find((delivery) => delivery.id === state.activeId);
  return {
    name: pkg.project.name,
    sourceProjectId: pkg.project.id,
    kind: pkg.kind,
    packageId: pkg.packageId,
    productVersion: pkg.productVersion,
    bindingId: config.bindingId,
    sourceUrl: config.sourceUrl,
    internalUrl: config.internalUrl,
    sourceBranch: config.sourceBranch,
    targetBranch: config.targetBranch,
    mode: config.mode,
    internalPaths: config.internalPaths,
    historyCount: state?.deliveries.length ?? 0,
    taskCount: pkg.files.filter((file) => /^operations\/[a-f0-9]{32}\.json$/.test(file.path)).length,
    issueCount: Object.keys(state?.issues ?? {}).length,
    accepted: state?.accepted ?? null,
    active: active ? { id: active.id, prUrl: active.prUrl ?? null, status: active.status } : null,
  };
}

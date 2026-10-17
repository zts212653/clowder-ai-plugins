import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fail } from './config.mjs';
import { assertLedger } from './ledger.mjs';
import { versionPolicy } from './policy.mjs';
import { validateSnapshot } from './recording.mjs';
import { taskActions } from './task-store.mjs';
import { noSymlinks } from './transfer-objects.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const knownPath = (path) =>
  /^(?:ledger\.json|sync-settings\.json|operations\/(?:latest|[a-f0-9]{32})\.json)$/.test(path);
const busy = new Set(['RUNNING', 'CANCELLING', 'STOP_UNCONFIRMED']);
export function parseTransferFile(file) {
  if (
    !file ||
    Object.keys(file).some((key) => !['path', 'content', 'sha256'].includes(key)) ||
    !knownPath(file.path) ||
    typeof file.content !== 'string' ||
    digest(file.content) !== file.sha256
  )
    fail('TRANSFER_FILE_INVALID', '迁移文件路径、内容或完整性摘要无效。');
  try {
    const value = JSON.parse(file.content);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch {
    fail('TRANSFER_FILE_INVALID', '迁移记录不是有效 JSON 对象。');
  }
}
function validateTask(value, path, config) {
  if (busy.has(value.status))
    fail('TRANSFER_TASK_ACTIVE', '仍有运行、取消中或停止未确认的任务；停止并核实原执行器后再迁移。');
  if (
    (value.schema !== undefined && value.schema !== 2) ||
    path !== `operations/${value.id}.json` ||
    value.bindingId !== config.bindingId ||
    !taskActions.has(value.action) ||
    !['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'].includes(value.status) ||
    !Number.isInteger(value.ownerPid) ||
    value.ownerPid < 1 ||
    !/^[a-f0-9]{64}$/.test(value.inputHash ?? '') ||
    (value.schema === 2 && value.deliveryId !== null && !/^[a-f0-9]{24}$/.test(value.deliveryId ?? '')) ||
    (value.deliveryIds !== undefined &&
      (!Array.isArray(value.deliveryIds) || value.deliveryIds.some((id) => !/^[a-f0-9]{24}$/.test(id)))) ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    !Array.isArray(value.steps) ||
    value.steps.some(
      (step) =>
        !step ||
        typeof step.id !== 'string' ||
        typeof step.label !== 'string' ||
        !['PENDING', 'RUNNING', 'DONE', 'FAILED'].includes(step.status) ||
        (value.schema === 2 &&
          (!Number.isInteger(step.stage) || step.stage < 0 || step.stage > 5 || typeof step.group !== 'string')),
    )
  )
    fail('TRANSFER_TASK_INVALID', '迁移执行记录版本、绑定或步骤不完整；原任务不能被当成新任务。');
  if (value.schema === 2) {
    validateSnapshot(value.configSnapshot);
    if (value.configSnapshot.bindingId !== config.bindingId)
      fail('TRANSFER_TASK_INVALID', '迁移任务配置摘要属于其他仓库绑定。');
  }
  if (value.projectId !== undefined && value.projectId !== 'default' && !/^[a-f0-9]{24}$/.test(value.projectId))
    fail('TRANSFER_TASK_INVALID', '迁移任务的项目身份无效。');
}
export function validateFiles(files, config, kind) {
  if (!Array.isArray(files) || files.length > 10000 || new Set(files.map((file) => file?.path)).size !== files.length)
    fail('TRANSFER_FILE_INVALID', '迁移文件数量、清单或重复路径无效。');
  if (kind === 'template' && files.length) fail('TRANSFER_FILE_INVALID', '配置模板不能包含同步进度。');
  const values = new Map(files.map((file) => [file.path, parseTransferFile(file)]));
  for (const [path, value] of values) {
    if (path === 'ledger.json') {
      if (value.schema !== 1 || value.bindingId !== config.bindingId || !Array.isArray(value.deliveries))
        fail('TRANSFER_BINDING_MISMATCH', '迁移台账与配置的仓库绑定不一致。');
      assertLedger(value);
    } else if (path === 'sync-settings.json') {
      const policy = versionPolicy(value);
      if (
        Object.keys(value).some((key) => !['schema', 'mode', 'internalPaths', 'mergePaths'].includes(key)) ||
        value.schema !== 1 ||
        value.mode !== config.mode ||
        JSON.stringify(policy.internalPaths) !== JSON.stringify(config.internalPaths ?? []) ||
        JSON.stringify(policy.mergePaths) !== JSON.stringify(config.mergePaths ?? [])
      )
        fail('TRANSFER_SETTINGS_CONFLICT', '迁移模式与保留文件规则不一致。');
    } else if (path !== 'operations/latest.json') validateTask(value, path, config);
  }
  const latest = values.get('operations/latest.json');
  if (latest && (Object.keys(latest).some((key) => key !== 'id') || !values.has(`operations/${latest.id}.json`)))
    fail('TRANSFER_TASK_INVALID', '迁移最新任务索引缺少对应的原始任务。');
  if (kind === 'migration' && !values.has('ledger.json'))
    fail('TRANSFER_BASELINE_REQUIRED', '完整迁移需要已登记的同步基线。');
  const ledger = values.get('ledger.json');
  for (const delivery of ledger?.deliveries ?? [])
    for (const id of delivery.taskIds ?? [])
      if (!values.has(`operations/${id}.json`))
        fail('TRANSFER_TASK_MISSING', '同步历史引用了缺失的执行记录，不能导出不完整迁移包。');
  return values;
}
export async function exportFiles(config) {
  await noSymlinks(config.stateDir);
  const paths = ['ledger.json', 'sync-settings.json'];
  try {
    const folder = join(config.stateDir, 'operations');
    await noSymlinks(folder);
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) fail('TRANSFER_SYMLINK', '执行记录不能通过符号链接导出。');
      if (knownPath(`operations/${entry.name}`)) paths.push(`operations/${entry.name}`);
      else if (entry.name.endsWith('.json'))
        fail('TRANSFER_FILE_UNKNOWN', '执行记录目录中有未知 JSON 文件；请核对原历史，不能静默遗漏。');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const files = [];
  let total = 0;
  for (const path of paths.sort()) {
    const absolute = join(config.stateDir, ...path.split('/'));
    try {
      await noSymlinks(absolute);
      const info = await lstat(absolute);
      total += info.size;
      if (!info.isFile() || total > 32 * 1024 * 1024)
        fail('TRANSFER_TOO_LARGE', '逻辑记录超过 32 MiB 或不是普通文件。');
      const content = await readFile(absolute, 'utf8');
      files.push({ path, content, sha256: digest(content) });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return files;
}
export async function restoreFiles(pkg, config, projectId) {
  for (const file of pkg.files) {
    let content = file.content;
    if (/^operations\/[a-f0-9]{32}\.json$/.test(file.path)) {
      const value = JSON.parse(content);
      value.transferProvenance = { packageId: pkg.packageId, projectId: value.projectId ?? pkg.project.id };
      if (projectId !== undefined) value.projectId = projectId;
      content = JSON.stringify(value, null, 2);
    }
    const path = join(config.stateDir, ...file.path.split('/'));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { mode: 0o600, flag: 'wx' });
  }
}

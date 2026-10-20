import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fail, validateConfig } from './config.mjs';
import { projectRegistry } from './project-registry.mjs';
import { privateLocation, readPrivate, writePrivate } from './private-config.mjs';
import { configuredReceiver } from './settings.mjs';
import { restoreTransfer, packageSummary, validateTransfer } from './transfer-package.mjs';
import { pauseTransferredRun, saveTransferState } from './transfer-state.mjs';
import { recoverRegistrationLock } from './transfer-lock-recovery.mjs';
import { receivingRepositoryKey } from './repository-identity.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const validId = (value) => /^[a-f0-9]{64}$/.test(value ?? '');

export async function transferWorkspace(file, options = {}) {
  const registry = await projectRegistry(file);
  const storage = `${registry.root}.transfers`;
  async function preview(input) {
    const pkg = validateTransfer(input);
    if (pkg.config.allowLocal && !options.allowLocalTransfers)
      fail(
        'TRANSFER_LOCAL_REPOSITORY',
        '迁移包不能引用另一台机器的本地仓库路径。请使用 HTTPS 或 SSH 仓库地址重新导出。',
      );
    await privateLocation(join(storage, 'inbox', `${pkg.packageId}.json`));
    await mkdir(join(storage, 'inbox'), { recursive: true });
    await writePrivate(join(storage, 'inbox', `${pkg.packageId}.json`), pkg);
    return packageSummary(pkg);
  }
  async function staged(id) {
    if (!validId(id)) fail('TRANSFER_PACKAGE_REQUIRED', '请选择并检查迁移文件。');
    const value = (await readPrivate(join(storage, 'inbox', `${id}.json`))).config;
    if (!value) fail('TRANSFER_PACKAGE_REQUIRED', '未找到已检查的文件，请重新选择同一迁移文件。');
    const pkg = validateTransfer(value);
    if (pkg.packageId !== id) fail('TRANSFER_PACKAGE_CHANGED', '待导入文件已变化，请重新选择并核对。');
    return pkg;
  }
  async function install(input) {
    if (
      Object.keys(input).some((key) => !['packageId', 'name', 'expectedWorkspaceRevision', 'projectId'].includes(key))
    )
      fail('TRANSFER_INPUT_INVALID', '导入仅接受已检查文件、项目名称和列表版本，不能指定目录或命令。');
    const pkg = await staged(input.packageId);
    if (pkg.config.allowLocal && !options.allowLocalTransfers)
      fail('TRANSFER_LOCAL_REPOSITORY', '正式服务不能导入机器本地仓库路径。');
    return registry.locked(async () => {
      const saved = await registry.read();
      const requestId = digest(`transfer:${pkg.packageId}`).slice(0, 32);
      const id = digest(`${registry.root}:${requestId}`).slice(0, 24);
      const configurationFile = registry.configuration(id);
      const target = dirname(configurationFile);
      const receiptFile = join(target, 'import-receipt.json');
      const receipt = (await readPrivate(receiptFile)).config;
      const existing = saved.value.projects.find((entry) => entry.id === id);
      if (existing) {
        if (!receipt || receipt.id !== id || receipt.packageId !== pkg.packageId || !existing.configured)
          fail('TRANSFER_RECEIPT_CONFLICT', '原导入回执与项目不一致，保留原文件，请恢复回执后再查询。');
        const receiver = await configuredReceiver((await readPrivate(configurationFile)).config);
        if (receiver.config.bindingId !== packageSummary(pkg).bindingId)
          fail(
            'TRANSFER_RECEIPT_CONFLICT',
            '原导入项目后来已改为另一套仓库或文件规则，请在原项目核对；不能将其当成本包继续。',
          );
        return { project: { id, name: existing.name }, reused: true };
      }
      if (input.expectedWorkspaceRevision !== saved.revision)
        fail('PROJECT_LIST_CHANGED', '项目列表已变化，请刷新并再次确认导入；原项目没有覆盖。');
      const name = validName(input.name);
      if (saved.value.projects.some((entry) => entry.name === name))
        fail('PROJECT_NAME_EXISTS', '项目名称已存在，请换一个名称。');
      if (saved.value.projects.length >= 100) fail('PROJECT_LIMIT', '单个工作台最多 100 个项目。');
      for (const entry of saved.value.projects) {
        const config = (await readPrivate(registry.configuration(entry.id))).config;
        if (entry.configured && !config)
          fail('PROJECT_CONFIGURATION_MISSING', '已有项目的配置丢失，请先恢复；不能证明接收范围互不冲突。');
        if (
          config &&
          receivingRepositoryKey(config.internalUrl) === receivingRepositoryKey(pkg.config.internalUrl) &&
          config.targetBranch === pkg.config.targetBranch
        )
          fail(
            'PROJECT_DESTINATION_IN_USE',
            `项目“${entry.name}”已管理此接收分支；请在原项目继续，不能导入第二个执行器。`,
          );
      }
      await privateLocation(join(target, 'state', 'ledger.json'));
      // Publish the pre-existing default index before creating its project directory.
      // A crash after the directory rename can then finish registration on retry.
      if (saved.revision === null) await registry.save(saved.value);
      await mkdir(dirname(target), { recursive: true });
      const record = receipt ?? { packageId: pkg.packageId, id, name, createdAt: new Date().toISOString() };
      if (receipt) {
        if (receipt.packageId !== pkg.packageId || receipt.id !== id || receipt.name !== name)
          fail('TRANSFER_RECEIPT_CONFLICT', '未完成登记的原导入使用了其他名称或身份，请使用原名称恢复。');
        const receiver = await configuredReceiver((await readPrivate(configurationFile)).config);
        if (
          receiver.config.stateDir !== join(target, 'state') ||
          receiver.config.bindingId !== packageSummary(pkg).bindingId
        )
          fail('TRANSFER_PATH_CONFLICT', '原导入目录或仓库绑定已变化，未覆盖。');
      } else {
        try {
          await access(target);
          fail('TRANSFER_PATH_CONFLICT', '目标项目目录已有内容且没有导入回执，未覆盖。');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        const stage = join(storage, `staging-${randomUUID()}`);
        await mkdir(stage, { recursive: true });
        const restored = await restoreTransfer(pkg, join(stage, 'state'), { projectId: id });
        const receiver = await configuredReceiver(restored.config);
        const state = await receiver.read();
        if (state) {
          pauseTransferredRun(state);
          await receiver.store.save(state);
        }
        await saveTransferState(receiver.config, {
          schema: 1,
          packageId: pkg.packageId,
          kind: pkg.kind,
          status: 'IMPORTED',
          importedAt: record.createdAt,
          sourceProjectId: pkg.project.id,
          projectId: id,
          summary: packageSummary(pkg),
        });
        const config = validateConfig({
          ...restored.config,
          configurationSource: 'workbench',
          stateDir: join(target, 'state'),
        });
        await writePrivate(join(stage, 'config.json'), config);
        await writePrivate(join(stage, 'import-receipt.json'), record);
        await rename(stage, target);
      }
      saved.value.projects.push({
        id,
        name,
        originalName: name,
        requestId,
        configured: true,
        createdAt: record.createdAt,
      });
      await registry.save(saved.value);
      return { project: { id, name }, reused: Boolean(receipt) };
    });
  }
  return { preview, staged, install, recoverRegistration: (input) => recoverRegistrationLock(registry.path, input) };
}
function validName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\x00-\x1f\x7f]/.test(value))
    fail('INVALID_PROJECT_NAME', '请填写 1～80 个字符的项目名称。');
  return value.trim();
}

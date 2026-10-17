import { isAbsolute, join } from 'node:path';
import { readText, writeJson } from './atomic-file.mjs';
import { fail, validateConfig } from './config.mjs';
import { Receiver } from './engine.mjs';
import { privateLocation } from './private-config.mjs';
import { assertTransferWritable } from './transfer-state.mjs';

export async function configuredReceiver(config) {
  await assertStateLocation(config);
  let settings;
  try {
    settings = JSON.parse(await readText(join(config.stateDir, 'sync-settings.json')));
  } catch (error) {
    if (error.code !== 'ENOENT') fail('SETTINGS_UNREADABLE', '本地模式设置无法读取，暂停；不能自动恢复默认值');
  }
  if (
    settings !== undefined &&
    (!settings || settings.schema !== 1 || !['continuous', 'version'].includes(settings.mode))
  )
    fail('SETTINGS_UNREADABLE', '本地模式设置格式无效');
  const receiver = new Receiver(
    settings
      ? { ...config, mode: settings.mode, internalPaths: settings.internalPaths, mergePaths: settings.mergePaths }
      : config,
  );
  if (config.mode && config.mode !== receiver.config.mode)
    fail('MODE_CONFLICT', '私有配置模式与已保存模式不同，请核对配置或使用独立台账目录');
  if (
    settings &&
    (config.internalPaths || config.mergePaths) &&
    validateConfig(config).bindingId !== receiver.config.bindingId
  )
    fail('MODE_CONFLICT', '私有配置文件规则与已保存规则不同，请核对后使用原规则或独立台账');
  await receiver.read();
  return receiver;
}
async function assertStateLocation(config) {
  if (typeof config?.stateDir !== 'string' || !isAbsolute(config.stateDir))
    fail('INVALID_STATE_DIR', '私有台账目录需要绝对路径，请核对 stateDir；未创建或覆盖台账');
  if (config.allowLocal !== true) {
    try {
      await privateLocation(join(config.stateDir, 'repo-sync-state.json'));
    } catch (error) {
      if (['PRIVATE_CONFIG_IN_INSTALLATION', 'PRIVATE_CONFIG_IN_REPOSITORY'].includes(error.code))
        fail(
          'PRIVATE_STATE_LOCATION',
          '台账目录必须在 Git 工作仓、插件安装和 node_modules 之外。请备份并迁移原目录后更新 stateDir；不要重置已有同步记录',
        );
      fail('PRIVATE_STATE_UNREADABLE', '无法核对私有台账目录，请检查路径和读取权限；尚未创建或写入台账');
    }
  }
}
export async function configure(receiver, input) {
  return receiver.store.locked(async () => {
    await assertTransferWritable(receiver.config);
    if (!['continuous', 'version'].includes(input.mode)) fail('INVALID_MODE', '请选择同步模式');
    if (await receiver.read())
      fail('ALREADY_ADOPTED', '已启用绑定不能更换模式或文件规则，请为另一种模式配置独立台账目录');
    const settings = { schema: 1, mode: input.mode, internalPaths: input.internalPaths, mergePaths: input.mergePaths };
    const next = new Receiver({ ...receiver.config, ...settings });
    const path = join(receiver.config.stateDir, 'sync-settings.json');
    await writeJson(path, settings);
    return next;
  });
}

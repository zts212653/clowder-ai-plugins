import { join } from 'node:path';
import { fail } from './config.mjs';
import { readPrivate, writePrivate } from './private-config.mjs';

export async function transferState(config) {
  if (!config?.stateDir) return null;
  const value = (await readPrivate(join(config.stateDir, 'transfer.json'))).config;
  if (
    value &&
    (value.schema !== 1 ||
      value.bindingId !== config.bindingId ||
      !['IMPORTED', 'EXPORTED', 'ACTIVE'].includes(value.status) ||
      !['template', 'migration'].includes(value.kind) ||
      !/^[a-f0-9]{64}$/.test(value.packageId ?? ''))
  )
    fail('TRANSFER_STATE_INVALID', '迁移状态与仓库绑定不一致，请恢复原迁移记录；尚未执行同步。');
  return value;
}
export async function saveTransferState(config, value) {
  await writePrivate(join(config.stateDir, 'transfer.json'), { ...value, schema: 1, bindingId: config.bindingId });
}
export async function assertTransferWritable(config) {
  const value = await transferState(config);
  if (value && value.status !== 'ACTIVE')
    fail(
      'TRANSFER_ACTIVATION_REQUIRED',
      value.status === 'EXPORTED'
        ? '原环境已暂停移交。请在设置的导入导出中确认接收环境已停止，再核验并明确恢复此环境；原交付和映射保留。'
        : '此项目已导入但尚未启用。请在设置的导入导出中补充本人的认证、运行核验并明确启用，再继续原交付。',
    );
}

export function pauseTransferredRun(state) {
  if (!state?.automation || state.automation.status === 'COMPLETE') return;
  state.automation.status = 'PAUSED';
  if (state.automation.autoMerge !== undefined) state.automation.autoMerge = false;
  state.automation.updatedAt = new Date().toISOString();
  state.automation.pauseRequested = {
    afterDeliveryId: state.activeId ?? null,
    requestedAt: state.automation.updatedAt,
  };
}

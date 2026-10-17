import { createHash } from 'node:crypto';
import { fail } from './config.mjs';

export function assertIssueLedger(state) {
  if (state.issueAdapterId !== undefined && !/^[a-f0-9]{64}$/.test(state.issueAdapterId))
    fail('LEDGER_INVALID', 'Issue 自动化配置标识损坏，不能重建创建意图');
  if (state.issueIntents !== undefined) {
    if (
      !state.issueIntents ||
      Array.isArray(state.issueIntents) ||
      typeof state.issueIntents !== 'object' ||
      !state.issueAdapterId
    )
      fail('LEDGER_INVALID', 'Issue 创建意图损坏，保留原台账，不重复创建');
    for (const [sourceId, intent] of Object.entries(state.issueIntents)) {
      const key = createHash('sha256')
        .update(JSON.stringify([state.bindingId, sourceId]))
        .digest('hex');
      if (intent?.key !== key || !Number.isFinite(Date.parse(intent.time)))
        fail('LEDGER_INVALID', 'Issue 创建来源或意图时间无效，不能当作未创建');
    }
  }
  assertIssueMappings(state);
}
function assertIssueMappings(state) {
  for (const mapping of Object.values(state.issues)) {
    if (
      mapping?.confirmedBy === 'platform' &&
      (!/^[a-f0-9]{64}$/.test(mapping.key ?? '') ||
        typeof mapping.internalId !== 'string' ||
        typeof mapping.url !== 'string' ||
        !['open', 'closed'].includes(mapping.state) ||
        !Array.isArray(mapping.receipts))
    )
      fail('LEDGER_INVALID', '平台 Issue 映射损坏，暂停核对，不能重建或关单');
  }
}

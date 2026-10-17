import { validateAutomation } from './automation.mjs';
import { commitPolicy } from './commit-policy.mjs';
import { fail } from './config.mjs';
import { validateDevelopmentReplay } from './development-history.mjs';
import { assertIssueLedger } from './issue-ledger.mjs';
import { validateMergeObservation } from './merge-readiness.mjs';
import { validateRecording } from './recording.mjs';

const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const pair = (value) => value && sha(value.upstream) && sha(value.internal);
export function assertLedger(state) {
  validateAutomation(state.automation);
  if (
    !pair(state.accepted) ||
    !pair(state.initial) ||
    !sha(state.latest) ||
    !Array.isArray(state.queue) ||
    !Array.isArray(state.events) ||
    !state.issues ||
    Array.isArray(state.issues) ||
    typeof state.issues !== 'object'
  )
    fail('LEDGER_INVALID', '台账缺少接受版本、队列或映射等必要字段；暂停，不能重建空台账');
  if (state.activeId !== null && typeof state.activeId !== 'string')
    fail('LEDGER_INVALID', '活动交付身份无效');
  assertIssueLedger(state);
  const statuses = [
    'ISSUES_REQUIRED',
    'CODE_PREPARE_REQUIRED',
    'PUSH_RESULT_UNKNOWN',
    'PR_REQUIRED',
    'WAITING_APPROVAL',
    'CODE_ACCEPTED_PENDING_METADATA',
    'COMPLETE',
    'CANCELLED',
  ];
  const identities = new Set();
  for (const delivery of state.deliveries) {
    assertDelivery(delivery, identities, statuses);
    identities.add(delivery.id);
  }
  if (state.activeId !== null && !identities.has(state.activeId))
    fail('LEDGER_INVALID', '活动交付不存在，暂停；不能自动丢弃恢复状态');
  const pending = state.deliveries.filter((delivery) => !['COMPLETE', 'CANCELLED'].includes(delivery.status));
  if (pending.length > 1 || (pending.length === 1 && pending[0].id !== state.activeId))
    fail('LEDGER_INVALID', '未完成交付与活动身份不一致，暂停以防丢失恢复任务');
}
function assertDelivery(delivery, identities, statuses) {
  validateMergeObservation(delivery, fail);
  if (
    !delivery ||
    !/^[a-f0-9]{24}$/.test(delivery.id ?? '') ||
    identities.has(delivery.id) ||
    !statuses.includes(delivery.status) ||
    !pair(delivery.base) ||
    (delivery.candidate !== null && !sha(delivery.candidate))
  )
    fail('LEDGER_INVALID', '交付身份、状态或冻结基线无效，暂停；不可跳过原交付或重建台账');
  validateRecording(delivery);
  if (
    delivery.cancellation &&
    (!['REQUESTED', 'MERGED', 'COMPLETE'].includes(delivery.cancellation.status) ||
      !Number.isFinite(Date.parse(delivery.cancellation.requestedAt)) ||
      (delivery.cancellation.status === 'COMPLETE' && delivery.status !== 'CANCELLED'))
  )
    fail('LEDGER_INVALID', '原 PR 撤销记录不完整，保留原任务与对象。');
  if (delivery.supersedes !== undefined && !/^[a-f0-9]{24}$/.test(delivery.supersedes))
    fail('LEDGER_INVALID', '重试交付的历史来源无效。');
  if (
    delivery.internalCommitCount !== undefined &&
    (!Number.isSafeInteger(delivery.internalCommitCount) || delivery.internalCommitCount < 1)
  )
    fail('LEDGER_INVALID', '内部候选提交数量无效。');
  if (delivery.source?.developmentReplay) validateDevelopmentReplay(delivery.source.developmentReplay);
  if (delivery.developmentMappings !== undefined) {
    const sources = delivery.source?.developmentReplay?.commits;
    if (
      !Array.isArray(sources) ||
      !Array.isArray(delivery.developmentMappings) ||
      delivery.developmentMappings.length !== sources.length ||
      new Set(delivery.developmentMappings.map((m) => m.source)).size !== sources.length ||
      new Set(delivery.developmentMappings.map((m) => m.internal)).size !== sources.length ||
      delivery.developmentMappings.some(
        (m) => !sha(m.source) || !sha(m.internal) || !sources.includes(m.source),
      )
    )
      fail('COMMIT_MAPPING_INVALID', '开发提交的内外 SHA 映射不完整，保留原交付。');
  }
  if (delivery.candidate && delivery.source?.developmentReplay && !delivery.developmentMappings)
    fail('COMMIT_MAPPING_INVALID', '已重放候选缺少逐条开发提交映射，不能发布或接受。');
  if (delivery.commitPolicy)
    commitPolicy({
      commitStrategy: delivery.commitPolicy.strategy,
      receivingIdentity: delivery.commitPolicy.identity,
    });
  if (
    delivery.commitMappings !== undefined &&
    (!Array.isArray(delivery.commitMappings) ||
      delivery.commitMappings.some((item) => !sha(item.source) || !sha(item.internal)) ||
      new Set(delivery.commitMappings.map((item) => item.source)).size !== delivery.commitMappings.length ||
      delivery.commitMappings.length !== delivery.commits?.length ||
      delivery.commits.some((source) => !delivery.commitMappings.some((item) => item.source === source)))
  )
    fail('COMMIT_MAPPING_INVALID', '内外 SHA 映射缺失或重复，保留原候选与台账；不能跳过核验。');
  if (
    delivery.candidate &&
    delivery.commitPolicy?.strategy === 'rewrite' &&
    delivery.mode !== 'version' &&
    !delivery.commitMappings
  )
    fail('COMMIT_MAPPING_INVALID', '重写交付缺少内外 SHA 映射，不能继续发布或验收。');
  if (
    delivery.status === 'WAITING_APPROVAL' &&
    (!sha(delivery.candidate) ||
      !delivery.checks?.passed ||
      delivery.checks.head !== delivery.candidate ||
      typeof delivery.prUrl !== 'string' ||
      !delivery.prUrl.startsWith('https://'))
  )
    fail('LEDGER_INVALID', '等待审核缺少已检查候选或 PR 引用，暂停；不能展示为已就绪');
  if (
    ['COMPLETE', 'CODE_ACCEPTED_PENDING_METADATA'].includes(delivery.status) &&
    !sha(delivery.acceptedInternal)
  )
    fail('LEDGER_INVALID', '接受状态缺少真实内部 commit，暂停核对原台账');
}

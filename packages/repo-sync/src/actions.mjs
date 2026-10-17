import { synchronize } from './automation.mjs';
import { baselineFile } from './baseline.mjs';
import { fail } from './config.mjs';
import { discover } from './github.mjs';
import { inspectBaseline, previewSync } from './journey-preview.mjs';
import { cancelDelivery } from './cancel-delivery.mjs';
import { inspectDeliverySource } from './inspect-delivery-source.mjs';

export async function dispatch(receiver, input, options = {}) {
  if (
    input.deliveryId &&
    [
      'issue',
      'sync-issues',
      'prepare',
      'pr',
      'clear-pr',
      'create-pr',
      'recover',
      'receipts',
      'cancel-version',
      'cancel-delivery',
      'inspect-delivery-source',
    ].includes(input.action) &&
    (await receiver.status())?.active?.id !== input.deliveryId
  )
    fail('DELIVERY_CHANGED', '活动交付已变化，请刷新后核对，不操作另一笔交付');
  const actions = {
    'inspect-baseline': () => inspectBaseline(receiver, input),
    'preview-sync': () => previewSync(receiver, input, options),
    synchronize: () => synchronize(receiver, input, options),
    'resume-sync': () => synchronize(receiver, input, options),
    'pause-sync': () => synchronize(receiver, input, options),
    'configure-continuation': () => synchronize(receiver, input, options),
    'configure-auto-merge': () => synchronize(receiver, input, options),
    heads: () => receiver.store.locked(() => receiver.git.heads()),
    adopt: () => receiver.adopt(input.upstream, input.internal),
    discover: () =>
      discover(
        receiver,
        {
          kind: input.targetKind ?? 'latest',
          value: input.targetValue,
          includeDirectCommits: input.includeDirectCommits,
        },
        options.sourceProvider,
      ),
    start: () => receiver.start(input.expectedTarget),
    issue: () => receiver.linkIssue(input.sourceId, input.internalId, input.url, input),
    'sync-issues': () => receiver.syncIssues(),
    prepare: () => receiver.prepare(),
    pr: () => receiver.linkPr(input.url, input),
    'clear-pr': () => receiver.linkPr(null, input),
    'create-pr': () => receiver.createPr(),
    recover: () => receiver.recover(),
    receipts: () => receiver.receipts(input.observations),
    tags: () => receiver.tags(),
    'select-tag': () => receiver.selectTag(input.tag),
    'cancel-version': () => receiver.cancelVersion(),
    'cancel-delivery': () => cancelDelivery(receiver, input),
    'inspect-delivery-source': () => inspectDeliverySource(receiver),
    'baseline-file': () => receiver.store.locked(() => baselineFile(receiver, input)),
  };
  if (!Object.hasOwn(actions, input.action)) fail('UNKNOWN_ACTION', '未知操作');
  return actions[input.action]();
}

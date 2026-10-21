import type { TaskItem } from './business/model/index.js';
import type { DeliveryReceipt } from './migration-source.js';
import type { LegacyReadPort, LegacySourceScope } from './operational-source.js';
import { hash, identifier, json, record, scalar, strings } from './operational-source-values.js';

/** Reads only exact source identities and routing/admission metadata, never a
 * message body or Queue row (which embeds the message body). */
export async function pendingReceipt(
  reader: LegacyReadPort,
  scope: LegacySourceScope,
  task: TaskItem,
): Promise<DeliveryReceipt | undefined> {
  const outcome = task.automationState?.waitOutcome,
    wake = task.automationState?.issue?.pendingWake;
  if (outcome?.delivery !== 'pending' && !wake) return;
  const thread = identifier(task.threadId),
    pending = outcome?.delivery === 'pending' ? outcome : undefined;
  const index = pending
    ? `msg:idem:${scope.ownerUserId}:${thread}:github-wait:${task.id}:${pending.outcomeId}`
    : undefined;
  const messageId = index ? scalar(await reader.read('GET', scope.keyPrefix + index)) : wake!.messageId;
  let appended = false,
    accepted = false;
  if (messageId) {
    identifier(messageId);
    const meta = await hash(reader, scope.keyPrefix + 'msg:' + messageId, [
      'id',
      'userId',
      'threadId',
      'mentions',
      'deliveryStatus',
    ]);
    const mentions = meta.mentions ? strings(json(meta.mentions)) : [];
    const match =
      meta.id === messageId &&
      meta.userId === scope.ownerUserId &&
      meta.threadId === thread &&
      mentions.includes(task.ownerCatId!);
    if (!match) throw new Error('Pending message identity differs from source binding');
    appended = true;
    const ids = scalar(
      await reader.read('HGET', scope.keyPrefix + `queue:{${encodeURIComponent(thread)}}:messages`, messageId),
    );
    // A surviving Queue index is an admission receipt, not a new send. History
    // alone cannot prove a wake after Queue retention; refuse that ambiguity.
    // Never read source.meta (which may embed arbitrary provider data).
    accepted = !!ids && strings(json(ids)).length > 0;
  }
  const neverStarted = !!pending && record(pending).publishClaimedAt === undefined && !messageId;
  return {
    taskId: task.id,
    ...(pending ? { outcomeId: pending.outcomeId } : {}),
    ...(messageId ? { messageId } : {}),
    sourceRef: `legacy-receipt:${task.id}:${messageId ?? 'unclaimed'}`,
    disposition: appended && accepted ? 'delivered' : neverStarted ? 'not-delivered' : 'ambiguous',
    messageAppended: appended,
    wakeAccepted: accepted,
  };
}

import type { CollectiveConnector } from './business/connector/index.js';
import { collectiveSourceIdentitySchema } from './business/contracts/index.js';
import type { OwnerViewMessageStore as IMessageStore } from './owner-participation-host-types.js';
import type { OwnerViewThreadStore as IThreadStore } from './owner-participation-host-types.js';

type InboxItem = Awaited<ReturnType<CollectiveConnector['listInbox']>>[number];
type OwnerThread = Awaited<ReturnType<IThreadStore['list']>>[number];
type Stage = 'queued' | 'started' | 'ended' | 'failed';

/** Owner-only display of the exact routed target; no Thread ID or custody enters Service. */
export async function ownerRequestExecution(
  item: InboxItem,
  thread: OwnerThread | undefined,
  messages: Pick<IMessageStore, 'getById'>,
  ownerUserId: string,
  connectionId: string,
): Promise<{ stage: Stage } | undefined> {
  const receipt = item.routeReceipt?.kind === 'thread_message' ? item.routeReceipt : undefined;
  const recipient = item.event.recipient?.kind === 'agent' ? item.event.recipient : undefined;
  if (!thread || !receipt || !recipient || receipt.catId !== recipient.agentId) return undefined;
  let message: Awaited<ReturnType<IMessageStore['getById']>>;
  try {
    message = await messages.getById(receipt.messageId);
  } catch {
    return undefined;
  }
  if (!message || message.userId !== ownerUserId || message.threadId !== thread.id) return undefined;
  const source = collectiveSourceIdentitySchema.safeParse(message.source?.meta?.participation);
  if (
    !source.success ||
    source.data.connectionId !== connectionId ||
    source.data.eventId !== item.event.eventId ||
    source.data.catId !== recipient.agentId
  )
    return undefined;
  const stage = message.deliveryStatus === 'queued' ? 'queued' : message.deliveryStatus === 'canceled' ? 'failed' : undefined;
  return stage === undefined ? undefined : { stage };
}

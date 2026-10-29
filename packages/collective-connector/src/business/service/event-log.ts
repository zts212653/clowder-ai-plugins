import { isDeepStrictEqual } from 'node:util';
import type {
  CollectiveAttentionRequest,
  CollectiveEventEnvelope,
  CollectiveLocation,
  CollectiveRecipient,
  CollectiveTarget,
  CollectiveWorkAcceptanceNotice,
  CollectiveWorkExecutionNotice,
  CollectiveWorkProgressReceipt,
  CollectiveWorkResultReceipt,
  CollectiveWorkRevisionNotice,
  CollectiveWorkWakeNotice,
  CollectiveMessageAttachment,
  CollectiveMessageQuote,
  CollectiveMessageRichBlock,
} from '../contracts/index.js';

import { CollectiveServiceError } from './errors.js';
import { requirePublicChannel } from './channel-authority.js';
import { resolveEventAddress } from './event-location.js';
import { requireMembership } from './identity-store.js';
import { requireParticipant } from './participation-store.js';
import { createStableId } from './persistence.js';
import { validateMessageAttachments, bindMessageAttachments } from './message-attachment-authority.js';
import { validateMessageQuotes } from './message-quote-authority.js';
import type { MutableServiceState } from './state.js';

export interface AppendEventInput {
  readonly coordinates: {
    readonly serviceInstanceId: string;
    readonly collectiveId: string;
    readonly clientEventId: string;
    readonly target?: CollectiveTarget;
    readonly location?: CollectiveLocation;
    readonly recipient?: CollectiveRecipient;
    readonly replyToEventId?: string;
    readonly attentionRequest?: CollectiveAttentionRequest;
    readonly workRequest?: 'entrust' | 'revise' | 'continue' | 'resume';
    readonly workRevisionNotice?: CollectiveWorkRevisionNotice;
    readonly workAcceptanceNotice?: CollectiveWorkAcceptanceNotice;
    readonly workExecutionNotice?: CollectiveWorkExecutionNotice;
    readonly workWakeNotice?: CollectiveWorkWakeNotice;
    readonly workResultReceipt?: CollectiveWorkResultReceipt;
    readonly workProgressReceipt?: CollectiveWorkProgressReceipt;
    readonly body: string;
    readonly attachments?: readonly CollectiveMessageAttachment[];
    readonly contextAttachments?: readonly CollectiveMessageQuote[];
    readonly richBlocks?: readonly CollectiveMessageRichBlock[];
  };
  readonly actorScope: string;
  readonly actor: CollectiveEventEnvelope['actor'];
  readonly now: number;
}

export function appendEvent(state: MutableServiceState, input: AppendEventInput): CollectiveEventEnvelope {
  const events = state.events[input.coordinates.collectiveId] ?? [];
  const address = resolveEventAddress(events, input.coordinates);
  requirePublicChannel(state, input.coordinates.collectiveId, address.location.channelId);
  validateMessageQuotes(state, input.coordinates);
  validateMessageAttachments(state, { collectiveId: input.coordinates.collectiveId,
    humanId: input.actor.kind === 'human' ? input.actor.humanId : input.actor.human.humanId,
    channelId: address.location.channelId, attachments: input.coordinates.attachments });
  assertRequestKind(input, address.recipient.kind);
  if (address.recipient.kind === 'human')
    requireMembership(state, input.coordinates.collectiveId, address.recipient.humanId);
  if (address.recipient.kind === 'agent')
    requireParticipant(state, {
      ...input.coordinates,
      connectionId: address.recipient.connectionId,
      catId: address.recipient.agentId,
      participationRevision: address.recipient.participationRevision,
      channelId: address.location.channelId,
      humanId: address.recipient.humanId,
    });
  const indexKey = `${input.coordinates.collectiveId}:${input.actorScope}:${input.coordinates.clientEventId}`;
  const existingId = state.clientEventIndex[indexKey];
  const existing = existingId ? events.find((event) => event.eventId === existingId) : undefined;
  if (existing) {
    const matches =
      existing.body === input.coordinates.body &&
      isDeepStrictEqual(existing.attachments, input.coordinates.attachments) &&
      isDeepStrictEqual(existing.contextAttachments, input.coordinates.contextAttachments) &&
      isDeepStrictEqual(existing.richBlocks, input.coordinates.richBlocks) &&
      existing.replyToEventId === input.coordinates.replyToEventId &&
      existing.attentionRequest === input.coordinates.attentionRequest &&
      existing.workRequest === input.coordinates.workRequest &&
      isDeepStrictEqual(existing.workRevisionNotice, input.coordinates.workRevisionNotice) &&
      isDeepStrictEqual(existing.workAcceptanceNotice, input.coordinates.workAcceptanceNotice) &&
      isDeepStrictEqual(existing.workExecutionNotice, input.coordinates.workExecutionNotice) &&
      isDeepStrictEqual(existing.workWakeNotice, input.coordinates.workWakeNotice) &&
      isDeepStrictEqual(existing.workResultReceipt, input.coordinates.workResultReceipt) &&
      isDeepStrictEqual(existing.workProgressReceipt, input.coordinates.workProgressReceipt) &&
      isDeepStrictEqual(existing.location, address.location) &&
      isDeepStrictEqual(existing.recipient, address.recipient) &&
      isDeepStrictEqual(existing.actor, input.actor);
    if (!matches) {
      throw new CollectiveServiceError('CLIENT_EVENT_CONFLICT', 'clientEventId already names a different event', 409);
    }
    return structuredClone(existing) as CollectiveEventEnvelope;
  }
  const event: CollectiveEventEnvelope = {
    serviceInstanceId: state.serviceInstanceId,
    collectiveId: input.coordinates.collectiveId,
    eventId: createStableId('evt_'),
    clientEventId: input.coordinates.clientEventId,
    sequence: (events.at(-1)?.sequence ?? 0) + 1,
    actor: input.actor,
    ...address,
    ...projectEventRelations(input.coordinates),
    body: input.coordinates.body,
    ...(input.coordinates.attachments ? { attachments: [...input.coordinates.attachments] } : {}),
    ...(input.coordinates.contextAttachments ? { contextAttachments: [...input.coordinates.contextAttachments] } : {}),
    ...(input.coordinates.richBlocks ? { richBlocks: [...input.coordinates.richBlocks] } : {}),
    acceptedAt: new Date(input.now).toISOString(),
  };
  events.push(event);
  state.events[input.coordinates.collectiveId] = events;
  state.clientEventIndex[indexKey] = event.eventId;
  bindMessageAttachments(state, event);
  return structuredClone(event);
}

function assertRequestKind(input: AppendEventInput, recipientKind: CollectiveRecipient['kind']) {
  if (input.coordinates.attentionRequest && (input.actor.kind !== 'human' || recipientKind !== 'channel')) {
    throw new CollectiveServiceError(
      'PARTICIPATION_INVALID',
      'A response request requires a Human and a public Channel',
      422,
    );
  }
  const acceptedByCat =
    ((input.coordinates.workAcceptanceNotice && input.coordinates.workRequest === 'entrust') ||
      (input.coordinates.workExecutionNotice && input.coordinates.workRequest === 'continue')) &&
    input.actor.kind === 'agent';
  if (
    input.coordinates.workRequest &&
    ((!acceptedByCat && input.actor.kind !== 'human') || recipientKind !== 'agent')
  ) {
    throw new CollectiveServiceError(
      'PARTICIPATION_INVALID',
      'A sustained request requires a Human and an exact participant',
      422,
    );
  }
}

function projectEventRelations(coordinates: AppendEventInput['coordinates']) {
  return {
    ...(coordinates.replyToEventId ? { replyToEventId: coordinates.replyToEventId } : {}),
    ...(coordinates.attentionRequest ? { attentionRequest: coordinates.attentionRequest } : {}),
    ...(coordinates.workRequest ? { workRequest: coordinates.workRequest } : {}),
    ...(coordinates.workRevisionNotice ? { workRevisionNotice: coordinates.workRevisionNotice } : {}),
    ...(coordinates.workAcceptanceNotice ? { workAcceptanceNotice: coordinates.workAcceptanceNotice } : {}),
    ...(coordinates.workExecutionNotice ? { workExecutionNotice: coordinates.workExecutionNotice } : {}),
    ...(coordinates.workWakeNotice ? { workWakeNotice: coordinates.workWakeNotice } : {}),
    ...(coordinates.workResultReceipt ? { workResultReceipt: coordinates.workResultReceipt } : {}),
    ...(coordinates.workProgressReceipt ? { workProgressReceipt: coordinates.workProgressReceipt } : {}),
  };
}

import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { collectiveHumanChannelCoordinatesSchema, collectiveSaveComposerDraftSchema,
  type CollectiveEventEnvelope, type CollectiveHumanMessageRequest } from '../contracts/index.js';
import { provenEventLocation } from './event-location.js';
import { CollectiveServiceError } from './errors.js';
import { requirePublicChannel } from './channel-authority.js';
import { attachmentHuman, denyAttachment, validateMessageAttachments } from './message-attachment-authority.js';
import { validateMessageQuotes } from './message-quote-authority.js';
import type { PersistentServiceState } from './persistence.js';
import type { MutableServiceState, ServiceState } from './state.js';

export const emptyComposerContent = () => ({ body: '', recipient: { kind: 'channel' as const }, recipientLabel: '' });
function draftKey(humanId: string, input: { collectiveId: string; channelId: string; rootEventId?: string }) {
  return JSON.stringify([input.collectiveId, humanId, input.channelId, input.rootEventId ?? null]);
}
function readKey(humanId: string, input: { collectiveId: string; channelId: string }) {
  return JSON.stringify([input.collectiveId, humanId, input.channelId]);
}
function requireChannel(state: ServiceState, input: { collectiveId: string; channelId: string; rootEventId?: string }) {
  requirePublicChannel(state, input.collectiveId, input.channelId);
  if (!input.rootEventId) return;
  const events = state.events[input.collectiveId] ?? [];
  const root = events.find(event => event.eventId === input.rootEventId);
  if (!root || provenEventLocation(events, root)?.channelId !== input.channelId) denyAttachment();
}

export class CollectiveHumanChannelState {
  constructor(private readonly persistence: PersistentServiceState) {}
  read(token: string, unsafe: unknown) {
    const input = collectiveHumanChannelCoordinatesSchema.parse(unsafe), state = this.persistence.snapshot();
    const { humanId } = attachmentHuman(state, token, input);
    requireChannel(state, input);
    const draft = state.composerDrafts[draftKey(humanId, input)] ?? { ...input, humanId, revision: 0, content: emptyComposerContent() };
    const position = state.readPositions[readKey(humanId, input)] ?? { sequence: 0 };
    const events = (state.events[input.collectiveId] ?? []).filter(event => provenEventLocation(state.events[input.collectiveId] ?? [], event)?.channelId === input.channelId);
    const read = position.eventId && events.some(event => event.eventId === position.eventId && event.sequence === position.sequence) ? position : { sequence: 0 };
    return { draft, read, unreadCount: events.filter(event => event.sequence > read.sequence).length };
  }
  save(token: string, unsafe: unknown) {
    const input = collectiveSaveComposerDraftSchema.parse(unsafe);
    return this.persistence.transaction(state => {
      const { humanId } = attachmentHuman(state, token, input);
      requireChannel(state, input);
      validateMessageAttachments(state, { ...input, humanId, attachments: input.content.attachments });
      validateMessageQuotes(state, { ...input, contextAttachments: input.content.contextAttachments });
      const key = draftKey(humanId, input), existing = state.composerDrafts[key];
      if (existing?.clientOperationId === input.clientOperationId) {
        if (!isDeepStrictEqual(existing.content, input.content))
          throw new CollectiveServiceError('DRAFT_OPERATION_CONFLICT', 'Draft operation identity was reused for different content', 409);
        return { status: 'stored' as const, draft: existing };
      }
      if ((existing?.revision ?? 0) !== input.expectedRevision) return {
        status: existing && isDeepStrictEqual(existing.content, input.content) ? 'stored' as const : 'conflict' as const,
        draft: existing ?? { serviceInstanceId: input.serviceInstanceId, collectiveId: input.collectiveId,
          channelId: input.channelId, ...(input.rootEventId ? { rootEventId: input.rootEventId } : {}), humanId, revision: 0, content: emptyComposerContent() },
      };
      const draft = { serviceInstanceId: input.serviceInstanceId, collectiveId: input.collectiveId, channelId: input.channelId,
        ...(input.rootEventId ? { rootEventId: input.rootEventId } : {}), humanId, revision: (existing?.revision ?? 0) + 1,
        content: input.content, clientOperationId: input.clientOperationId };
      state.composerDrafts[key] = draft;
      return { status: 'stored' as const, draft };
    });
  }
  markRead(token: string, unsafe: unknown) {
    const input = collectiveHumanChannelCoordinatesSchema.omit({ rootEventId: true }).extend({ eventId: z.string().min(1).max(160) }).strict().parse(unsafe);
    return this.persistence.transaction(state => {
      const { humanId } = attachmentHuman(state, token, input);
      const events = state.events[input.collectiveId] ?? [], event = events.find(item => item.eventId === input.eventId);
      if (!event || provenEventLocation(events, event)?.channelId !== input.channelId) denyAttachment();
      const key = readKey(humanId, input), existing = state.readPositions[key];
      if (!existing || event.sequence > existing.sequence)
        state.readPositions[key] = { eventId: event.eventId, sequence: event.sequence };
      return { read: state.readPositions[key] };
    });
  }
}

/** An old or different send never clears a newer draft; the event and consumption share one durable transaction. */
export function consumeSentComposerDraft(state: MutableServiceState, humanId: string,
  input: CollectiveHumanMessageRequest, event: CollectiveEventEnvelope) {
  if (!input.draftReceipt || !event.location || event.location.rootEventId !== input.draftReceipt.rootEventId) return;
  const key = draftKey(humanId, { collectiveId: event.collectiveId, channelId: event.location.channelId,
    rootEventId: input.draftReceipt.rootEventId });
  const draft = state.composerDrafts[key];
  if (!draft || draft.content.richEditor || (draft.content.voiceDraft && !draft.content.voiceDraft.applied) ||
      draft.revision !== input.draftReceipt.revision || draft.content.body.trim() !== event.body ||
      !isDeepStrictEqual(draft.content.attachments?.length ? draft.content.attachments : undefined, event.attachments) ||
      !isDeepStrictEqual(draft.content.contextAttachments?.length ? draft.content.contextAttachments : undefined, event.contextAttachments) ||
      !isDeepStrictEqual(draft.content.richBlocks?.length ? draft.content.richBlocks : undefined, event.richBlocks) ||
      !isDeepStrictEqual(draft.content.recipient, event.recipient) ||
      (draft.content.replyToEventId ?? input.draftReceipt.rootEventId) !== event.replyToEventId ||
      Boolean(draft.content.entrust) !== Boolean(event.workRequest) || Boolean(draft.content.responseRequested) !== Boolean(event.attentionRequest)) return;
  state.composerDrafts[key] = { ...draft, revision: draft.revision + 1, content: emptyComposerContent(), clientOperationId: `sent:${event.clientEventId}` };
}

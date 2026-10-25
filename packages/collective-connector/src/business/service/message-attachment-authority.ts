import { isDeepStrictEqual } from 'node:util';
import type { CollectiveMessageAttachment } from '../contracts/index.js';
import { assertServiceCoordinates } from './connection-authority.js';
import { provenEventLocation } from './event-location.js';
import { CollectiveServiceError } from './errors.js';
import { requireHumanAuthBinding, requireMembership, resolveSession } from './identity-store.js';
import type { MutableServiceState, ServiceState } from './state.js';

export function denyAttachment(): never {
  throw new CollectiveServiceError('ATTACHMENT_ACCESS_DENIED', 'Attachment is not available in this context', 403);
}
export function attachmentHuman(state: ServiceState, token: string, coordinates: { serviceInstanceId: string; collectiveId: string }) {
  assertServiceCoordinates(state, coordinates.serviceInstanceId, coordinates.collectiveId);
  const { human } = resolveSession(state, token);
  requireHumanAuthBinding(state, human.humanId);
  const membership = requireMembership(state, coordinates.collectiveId, human.humanId);
  return { humanId: human.humanId, revision: membership.revision };
}

/** Used inside the same event transaction, before an attachment can acquire any public source. */
export function validateMessageAttachments(state: ServiceState, input: {
  collectiveId: string; humanId: string; channelId: string; attachments?: readonly CollectiveMessageAttachment[];
}) {
  for (const attachment of input.attachments ?? []) {
    const record = state.messageAttachments[attachment.attachmentId];
    if (!record?.attachment || record.scope.collectiveId !== input.collectiveId ||
        record.scope.humanId !== input.humanId || record.scope.channelId !== input.channelId ||
        record.membershipRevision !== requireMembership(state, input.collectiveId, input.humanId).revision ||
        !isDeepStrictEqual(record.attachment, attachment)) denyAttachment();
  }
}
export function bindMessageAttachments(state: MutableServiceState, event: {
  eventId: string; attachments?: readonly CollectiveMessageAttachment[];
}) {
  for (const attachment of event.attachments ?? []) {
    const record = state.messageAttachments[attachment.attachmentId];
    if (!record) denyAttachment();
    if (!record.publishedEventIds.includes(event.eventId)) record.publishedEventIds.push(event.eventId);
  }
}
export function authorizeAttachmentRead(state: ServiceState, token: string, input: {
  serviceInstanceId: string; collectiveId: string; attachmentId: string; sourceEventId?: string;
}) {
  const actor = attachmentHuman(state, token, input);
  const record = state.messageAttachments[input.attachmentId];
  if (!record?.attachment || record.scope.collectiveId !== input.collectiveId) denyAttachment();
  if (input.sourceEventId) {
    const events = state.events[input.collectiveId] ?? [];
    const event = events.find(item => item.eventId === input.sourceEventId);
    if (!event || !record.publishedEventIds.includes(event.eventId) ||
        provenEventLocation(events, event)?.channelId !== record.scope.channelId ||
        !event.attachments?.some(item => isDeepStrictEqual(item, record.attachment))) denyAttachment();
  } else if (record.scope.humanId !== actor.humanId || record.membershipRevision !== actor.revision) denyAttachment();
  return { actor, record };
}

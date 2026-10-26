import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod';
import type { collectiveParticipationImageReadRequestSchema } from '../contracts/index.js';
import { provenEventLocation } from './event-location.js';
import { denyAttachment } from './message-attachment-authority.js';
import { inParticipationSourceScope, requireParticipationSource } from './participation-store.js';
import type { ServiceState } from './state.js';

/** Endpoint credentials and exact named participation are the sole Agent read authority.
 * A Human session or a staged upload can never stand in for that public source. */
export function authorizeModelAttachmentRead(
  state: ServiceState,
  token: string,
  input: Omit<z.infer<typeof collectiveParticipationImageReadRequestSchema>, 'image'>,
  selection: { eventId: string; attachmentId: string },
) {
  const source = requireParticipationSource(state, token, input);
  const events = state.events[input.collectiveId] ?? [];
  const event = events.find((item) => item.eventId === selection.eventId);
  const record = state.messageAttachments[selection.attachmentId];
  if (
    !event ||
    !inParticipationSourceScope(event, source) ||
    !record?.attachment ||
    record.scope.serviceInstanceId !== input.serviceInstanceId ||
    record.scope.collectiveId !== input.collectiveId ||
    provenEventLocation(events, event)?.channelId !== record.scope.channelId ||
    !record.publishedEventIds.includes(event.eventId) ||
    !event.attachments?.some((attachment) => isDeepStrictEqual(attachment, record.attachment))
  )
    denyAttachment();
  const ownerHumanId = state.connections[input.connectionId]!.authorizedHumanId!;
  return {
    record,
    membershipRevision: state.memberships[`${input.collectiveId}:${ownerHumanId}`]!.revision,
  };
}

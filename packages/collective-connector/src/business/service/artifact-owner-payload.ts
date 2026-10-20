import {
  type CollectiveArtifactConstraint,
  collectiveArtifactAnnotationInputSchema,
  collectiveArtifactModificationRequestInputSchema,
  collectiveArtifactPublishedSelectionInputSchema,
  collectiveArtifactReadPageSchema,
  collectiveArtifactReviewActionInputSchema,
  collectiveMediaReviewCommandSchema,
} from '../contracts/index.js';
import { resolveArtifactRequestAgent } from './artifact-agent-authority.js';
import { denyArtifact, requireArtifact, requireArtifactAction } from './artifact-authority.js';
import { provenEventLocation } from './event-location.js';
import { requireParticipant } from './participation-store.js';
import type { ServiceState } from './state.js';

/** Text opinions resolve public message references; media opinions are authenticated review metadata. */
export function humanArtifactOwnerPayload(
  state: ServiceState,
  constraint: CollectiveArtifactConstraint,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (constraint.action !== 'annotate' && constraint.action !== 'propose') return payload;
  if (constraint.action === 'annotate' && payload.kind === 'media-review') {
    const artifact = requireArtifact(state, constraint.collectiveId, constraint.artifactId);
    if (!['image/png', 'video/mp4'].includes(artifact.mediaType)) denyArtifact();
    return collectiveMediaReviewCommandSchema.parse(payload);
  }
  if (constraint.action === 'annotate' && payload.kind === 'review-action') {
    const input = collectiveArtifactReviewActionInputSchema.parse(payload);
    if (input.action.kind === 'set_annotation_state') return input;
    const action = input.action;
    const { message, location } = requirePublicArtifactMessage(state, constraint, action.messageEventId);
    if (!message.replyToEventId) denyArtifact();
    return {
      ...input,
      action: { ...input.action, body: message.body, location, replyToEventId: message.replyToEventId },
    };
  }
  if (constraint.action === 'annotate' && payload.kind === 'annotate-published-selections') {
    const input = collectiveArtifactPublishedSelectionInputSchema.parse(payload);
    const artifact = requireArtifact(state, constraint.collectiveId, constraint.artifactId);
    const bound = artifact.requestSources[input.messageEventId];
    resolveArtifactRequestAgent(state, artifact, input.messageEventId, constraint.humanId);
    if (!bound?.selections || bound.ownerRevision !== constraint.ownerRevision) denyArtifact();
    const command = humanArtifactOwnerPayload(
      state,
      { ...constraint, action: 'propose' },
      {
        kind: 'request-modification',
        messageEventId: input.messageEventId,
        annotationIds: bound.annotationIds,
        selections: bound.selections,
        expectedReviewRevision: bound.expectedReviewRevision,
      },
    );
    return { ...command, kind: 'annotate-published-selections' };
  }
  return humanTextArtifactPayload(state, constraint, payload);
}

/** Text comments and modification requests always retain their immutable public message identity. */
function humanTextArtifactPayload(
  state: ServiceState,
  constraint: CollectiveArtifactConstraint,
  payload: Record<string, unknown>,
) {
  const input =
    constraint.action === 'annotate'
      ? collectiveArtifactAnnotationInputSchema.parse(payload)
      : collectiveArtifactModificationRequestInputSchema.parse(payload);
  const artifact = requireArtifact(state, constraint.collectiveId, constraint.artifactId);
  const { message, location } = requirePublicArtifactMessage(state, constraint, input.messageEventId);
  if (input.kind === 'annotate') return { ...input, body: message.body, location };
  const recipient = message.recipient;
  if (recipient?.kind !== 'agent') denyArtifact();
  requireParticipant(state, {
    collectiveId: constraint.collectiveId,
    connectionId: recipient.connectionId,
    catId: recipient.agentId,
    participationRevision: recipient.participationRevision,
    humanId: recipient.humanId,
    channelId: location.channelId,
  });
  requireArtifactAction(state, artifact, recipient.humanId, 'propose');
  return {
    ...input,
    instruction: message.body,
    location,
    target: {
      humanId: recipient.humanId,
      catId: recipient.agentId,
      connectionId: recipient.connectionId,
      participationRevision: recipient.participationRevision,
    },
  };
}

/** The immutable Human intent accompanies a Cat read without trusting any Cat-supplied body or selection. */
export function agentArtifactOwnerPayload(
  state: ServiceState,
  constraint: CollectiveArtifactConstraint,
  submitted: Record<string, unknown>,
): Record<string, unknown> {
  if (constraint.action !== 'read') return submitted;
  const agent = constraint.agent;
  const artifact = requireArtifact(state, constraint.collectiveId, constraint.artifactId);
  const source = agent && artifact.requestSources[agent.requestEventId];
  if (!agent || !source) denyArtifact();
  const page = collectiveArtifactReadPageSchema.parse(submitted);
  const sharedRequest = humanArtifactOwnerPayload(
    state,
    { ...constraint, action: 'propose' },
    {
      kind: 'request-modification',
      messageEventId: agent.requestEventId,
      annotationIds: source.annotationIds,
      ...(source.selections ? { selections: source.selections } : {}),
      ...(source.rework ? { rework: source.rework } : {}),
      expectedReviewRevision: source.expectedReviewRevision,
    },
  );
  return { ...page, sharedRequest };
}

export function requirePublicArtifactMessage(
  state: ServiceState,
  constraint: Pick<CollectiveArtifactConstraint, 'collectiveId' | 'artifactId' | 'humanId'>,
  messageEventId: string,
) {
  const artifact = requireArtifact(state, constraint.collectiveId, constraint.artifactId);
  const events = state.events[constraint.collectiveId] ?? [];
  const message = events.find((event) => event.eventId === messageEventId);
  const location = message && provenEventLocation(events, message);
  if (
    !message ||
    message.actor.kind !== 'human' ||
    message.actor.humanId !== constraint.humanId ||
    !location ||
    location.channelId !== artifact.sourceLocation.channelId ||
    (location.rootEventId ?? message.eventId) !== (artifact.sourceLocation.rootEventId ?? artifact.sourceEventId)
  )
    denyArtifact();
  return { message, location };
}

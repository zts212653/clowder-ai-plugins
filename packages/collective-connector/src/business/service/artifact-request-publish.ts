import { isDeepStrictEqual } from 'node:util';
import { publishCollectiveArtifactRequestSchema } from '../contracts/index.js';
import type { z } from 'zod';
import { denyArtifact, requireArtifact, requireArtifactAction, requireArtifactHuman } from './artifact-authority.js';
import type { CollectiveArtifactConstraints } from './artifact-constraints.js';
import { humanArtifactOwnerPayload } from './artifact-owner-payload.js';
import { bindArtifactRequestSource } from './artifact-request-sources.js';
import { CollectiveServiceError } from './errors.js';
import { appendEvent } from './event-log.js';
import type { PersistentServiceState } from './persistence.js';
import type { ServiceState } from './state.js';

type Input = z.infer<typeof publishCollectiveArtifactRequestSchema>;

export async function publishArtifactRequest(
  persistence: PersistentServiceState,
  constraints: CollectiveArtifactConstraints,
  now: () => number,
  session: string,
  raw: unknown,
) {
  const input = publishCollectiveArtifactRequestSchema.parse(raw);
  if (input.recipient.kind !== 'agent') denyArtifact();
  const state = persistence.snapshot();
  const human = requireArtifactHuman(state, session, input.collectiveId);
  const replay = recoverPublication(state, input, human.humanId);
  if (replay) return { source: replay };
  const constraint = constraints.issue(session, {
    serviceInstanceId: input.serviceInstanceId,
    collectiveId: input.collectiveId,
    artifactId: input.artifactId,
    sourceEventId: input.sourceEventId,
    action: 'propose',
    ownerRevision: input.ownerRevision,
  });
  return persistence.transaction((draft) => {
    const freshHuman = requireArtifactHuman(draft, session, input.collectiveId);
    const recovered = recoverPublication(draft, input, freshHuman.humanId);
    if (recovered) return { source: recovered };
    const artifact = requireArtifact(draft, input.collectiveId, input.artifactId);
    const source = appendEvent(draft, {
      actorScope: `human:${freshHuman.humanId}`,
      actor: {
        kind: 'human',
        humanId: freshHuman.humanId,
        displayName: freshHuman.displayName,
        ...(freshHuman.avatarUrl ? { avatarUrl: freshHuman.avatarUrl } : {}),
      },
      now: now(),
      coordinates: {
        serviceInstanceId: input.serviceInstanceId,
        collectiveId: input.collectiveId,
        clientEventId: input.clientEventId,
        body: input.body,
        recipient: input.recipient,
        replyToEventId: artifact.sourceEventId,
        location: {
          channelId: artifact.sourceLocation.channelId,
          rootEventId: artifact.sourceLocation.rootEventId ?? artifact.sourceEventId,
        },
      },
    });
    const command = humanArtifactOwnerPayload(draft, constraint, {
      kind: 'request-modification',
      messageEventId: source.eventId,
      annotationIds: input.annotationIds,
      ...(input.selections ? { selections: input.selections } : {}),
      ...(input.rework ? { rework: input.rework } : {}),
      expectedReviewRevision: input.expectedReviewRevision,
    });
    bindArtifactRequestSource(draft, constraint, command);
    return { source };
  });
}

function recoverPublication(state: ServiceState, input: Input, humanId: string) {
  const artifact = requireArtifact(state, input.collectiveId, input.artifactId);
  // This acknowledges an immutable public event, not permission to execute its delegated owner operation.
  requireArtifactAction(state, artifact, humanId, 'read');
  if (artifact.serviceInstanceId !== input.serviceInstanceId || artifact.sourceEventId !== input.sourceEventId)
    denyArtifact();
  const event = (state.events[input.collectiveId] ?? []).find(
    (candidate) =>
      candidate.clientEventId === input.clientEventId &&
      candidate.actor.kind === 'human' &&
      candidate.actor.humanId === humanId,
  );
  if (!event) return null;
  const bound = artifact.requestSources[event.eventId];
  if (
    !bound ||
    event.body !== input.body ||
    !isDeepStrictEqual(event.recipient, input.recipient) ||
    bound.ownerRevision !== input.ownerRevision ||
    bound.expectedReviewRevision !== input.expectedReviewRevision ||
    !isDeepStrictEqual(bound.annotationIds, input.annotationIds) ||
    !isDeepStrictEqual(bound.selections, input.selections) ||
    !isDeepStrictEqual(bound.rework, input.rework)
  )
    throw new CollectiveServiceError(
      'COLLABORATION_OPERATION_CONFLICT',
      'This send operation already names another request',
      409,
    );
  return structuredClone(event);
}

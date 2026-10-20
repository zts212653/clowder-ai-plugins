import type { CollectiveArtifactRecord } from '../contracts/index.js';
import { artifactAccess, denyArtifact, requireArtifactAction } from './artifact-authority.js';
import { provenEventLocation } from './event-location.js';
import { requireParticipant } from './participation-store.js';
import type { ServiceState } from './state.js';

/** A named public request delegates only this Artifact; neither endpoint labels nor browser Cat IDs confer authority. */
export function resolveArtifactRequestAgent(
  state: ServiceState,
  artifact: CollectiveArtifactRecord,
  requestEventId: string,
  requestingHumanId?: string,
  mode: 'bound' | 'new-human-request' = 'bound',
) {
  const events = state.events[artifact.collectiveId] ?? [];
  const source = events.find((event) => event.eventId === requestEventId);
  const location = source && provenEventLocation(events, source);
  if (
    !source ||
    source.actor.kind !== 'human' ||
    source.recipient?.kind !== 'agent' ||
    (requestingHumanId !== undefined && source.actor.humanId !== requestingHumanId) ||
    !location ||
    location.channelId !== artifact.sourceLocation.channelId ||
    (location.rootEventId ?? source.eventId) !== (artifact.sourceLocation.rootEventId ?? artifact.sourceEventId)
  )
    denyArtifact();
  const recipient = source.recipient;
  const requester = requireArtifactAction(state, artifact, source.actor.humanId, 'propose');
  const membership = requireArtifactAction(state, artifact, recipient.humanId, 'propose');
  const bound = artifact.requestSources[requestEventId];
  if (bound?.selections) requireArtifactAction(state, artifact, source.actor.humanId, 'annotate');
  if (
    (!bound && mode !== 'new-human-request') ||
    (bound &&
      (bound.requestingHumanId !== source.actor.humanId ||
        bound.requesterMembershipRevision !== requester.revision ||
        bound.requesterAccessRevision !== artifactAccess(artifact, source.actor.humanId).revision ||
        bound.targetMembershipRevision !== membership.revision ||
        bound.targetAccessRevision !== artifactAccess(artifact, recipient.humanId).revision))
  )
    denyArtifact();
  requireParticipant(state, {
    collectiveId: artifact.collectiveId,
    connectionId: recipient.connectionId,
    catId: recipient.agentId,
    humanId: recipient.humanId,
    participationRevision: recipient.participationRevision,
    channelId: location.channelId,
  });
  return {
    humanId: source.actor.humanId,
    agent: {
      requestEventId,
      humanId: recipient.humanId,
      catId: recipient.agentId,
      connectionId: recipient.connectionId,
      participationRevision: recipient.participationRevision,
      membershipRevision: membership.revision,
      revocationEpoch: artifactAccess(artifact, recipient.humanId).revision,
    },
  };
}

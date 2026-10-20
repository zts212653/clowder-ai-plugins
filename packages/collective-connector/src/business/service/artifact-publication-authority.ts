import { createHash } from 'node:crypto';
import { type CollectiveArtifactPublication, prepareCollectiveArtifactPublicationSchema } from '../contracts/index.js';
import { denyArtifact, projectArtifact, requireArtifactAction, requireArtifactHuman } from './artifact-authority.js';
import { artifactIdentity } from './artifact-registration.js';
import { requireWorkSource } from './collaboration-command-helpers.js';
import { assertServiceCoordinates } from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import { requireHumanAuthBinding, requireMembership } from './identity-store.js';
import type { PersistentServiceState } from './persistence.js';
import type { ServiceState } from './state.js';

export const publicationHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function requirePublication(state: ServiceState, publicationId: string) {
  const record = state.artifactPublications[publicationId];
  if (!record) denyArtifact();
  assertServiceCoordinates(state, record.serviceInstanceId, record.collectiveId);
  const membership = requireMembership(state, record.collectiveId, record.humanId);
  requireHumanAuthBinding(state, record.humanId);
  const connection = state.connections[record.connectionId];
  if (
    membership.revision !== record.membershipRevision ||
    connection?.status !== 'connected' ||
    connection.authorizedHumanId !== record.humanId ||
    connection.collectiveId !== record.collectiveId ||
    connection.endpointId !== record.endpointId
  )
    denyArtifact();
  requireWorkSource(state, record.collectiveId, record.sourceEventId);
  return record;
}

export function requirePublicationHuman(state: ServiceState, session: string, publicationId: string) {
  const record = requirePublication(state, publicationId);
  if (requireArtifactHuman(state, session, record.collectiveId).humanId !== record.humanId) denyArtifact();
  return record;
}

export function projectPublication(state: ServiceState, record: CollectiveArtifactPublication) {
  const artifact = state.artifacts[record.artifactId];
  if (record.status === 'published' && artifact) requireArtifactAction(state, artifact, record.humanId, 'read');
  return {
    publicationId: record.publicationId,
    contentRef: record.contentRef,
    artifactId: record.artifactId,
    sourceEventId: record.sourceEventId,
    title: record.title,
    blobDigest: record.blobDigest,
    status: record.status,
    ...(record.status === 'published' && artifact
      ? { artifact: projectArtifact(state, artifact, record.humanId) }
      : {}),
  };
}

export async function prepareArtifactPublication(
  persistence: PersistentServiceState,
  now: () => number,
  session: string,
  unsafe: unknown,
) {
  const input = prepareCollectiveArtifactPublicationSchema.parse(unsafe);
  return persistence.transaction((state) => {
    assertServiceCoordinates(state, input.serviceInstanceId, input.collectiveId);
    const human = requireArtifactHuman(state, session, input.collectiveId);
    const connection = state.connections[input.connectionId];
    if (
      connection?.authorizedHumanId !== human.humanId ||
      connection.collectiveId !== input.collectiveId ||
      connection.status !== 'connected'
    )
      denyArtifact();
    const source = requireWorkSource(state, input.collectiveId, input.sourceEventId);
    if (input.workId) {
      const work = state.works[input.workId];
      if (!work || work.collectiveId !== input.collectiveId || work.sourceEventId !== input.sourceEventId)
        denyArtifact();
    }
    const publicationId = `artifact-publication:${publicationHash([input.serviceInstanceId, input.collectiveId, human.humanId, input.requestId])}`;
    const requestDigest = `sha256:${publicationHash(input)}`;
    const previous = state.artifactPublications[publicationId];
    if (previous) {
      requirePublicationHuman(state, session, publicationId);
      if (previous.requestDigest !== requestDigest)
        throw new CollectiveServiceError(
          'COLLABORATION_OPERATION_CONFLICT',
          'Publication operation already names another work',
          409,
        );
      return projectPublication(state, previous);
    }
    const contentRef = `collective-content:${publicationHash(publicationId)}`;
    const record: CollectiveArtifactPublication = {
      ...input,
      publicationId,
      contentRef,
      artifactId: artifactIdentity(input.serviceInstanceId, input.collectiveId, contentRef),
      humanId: human.humanId,
      membershipRevision: requireMembership(state, input.collectiveId, human.humanId).revision,
      endpointId: connection.endpointId,
      sourceLocation: source.location,
      requestDigest,
      status: 'pending',
      createdAt: new Date(now()).toISOString(),
    };
    state.artifactPublications[publicationId] = record;
    return projectPublication(state, record);
  });
}

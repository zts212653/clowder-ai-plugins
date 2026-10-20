import { isDeepStrictEqual } from 'node:util';
import {
  type CollectiveArtifactConstraint,
  collectiveArtifactAgentContextRequestSchema,
  collectiveArtifactModificationRequestCommandSchema,
} from '../contracts/index.js';
import { resolveArtifactRequestAgent } from './artifact-agent-authority.js';
import {
  artifactAccess,
  denyArtifact,
  requireArtifact,
  requireArtifactAction,
  requireArtifactCustodian,
} from './artifact-authority.js';
import { CollectiveServiceError } from './errors.js';
import { requireParticipationSource } from './participation-store.js';
import type { PersistentServiceState } from './persistence.js';
import type { MutableServiceState } from './state.js';

/** Permanent source-to-Artifact projection only. Original owners retain instructions and mutable request lifecycle. */
export function bindArtifactRequestSource(
  state: MutableServiceState,
  constraint: CollectiveArtifactConstraint,
  unsafe: Record<string, unknown>,
) {
  const input = collectiveArtifactModificationRequestCommandSchema.parse(unsafe);
  if (constraint.agent || constraint.action !== 'propose') denyArtifact();
  const artifact = requireArtifact(state, constraint.collectiveId, constraint.artifactId);
  const membership = requireArtifactAction(state, artifact, constraint.humanId, 'propose');
  if (
    (!input.rework && input.annotationIds.length + (input.selections?.length ?? 0) === 0) ||
    (input.rework && (input.annotationIds.length > 0 || input.selections !== undefined)) ||
    input.annotationIds.length + (input.selections?.length ?? 0) > 12
  )
    denyArtifact();
  if (input.selections) requireArtifactAction(state, artifact, constraint.humanId, 'annotate');
  requireArtifactCustodian(state, artifact);
  if (
    membership.revision !== constraint.membershipRevision ||
    artifactAccess(artifact, constraint.humanId).revision !== constraint.revocationEpoch ||
    artifact.custody.revision !== constraint.custodyRevision ||
    artifact.versions.at(-1)?.ownerRevision !== constraint.ownerRevision
  )
    denyArtifact();
  const target = resolveArtifactRequestAgent(
    state,
    artifact,
    input.messageEventId,
    constraint.humanId,
    'new-human-request',
  );
  if (
    input.target.catId !== target.agent.catId ||
    input.target.humanId !== target.agent.humanId ||
    input.target.connectionId !== target.agent.connectionId ||
    input.target.participationRevision !== target.agent.participationRevision
  )
    denyArtifact();
  const source = {
    requestEventId: input.messageEventId,
    ownerRevision: constraint.ownerRevision,
    blobDigest: constraint.blobDigest,
    annotationIds: input.annotationIds,
    ...(input.selections ? { selections: input.selections } : {}),
    ...(input.rework ? { rework: input.rework } : {}),
    expectedReviewRevision: input.expectedReviewRevision,
    requestingHumanId: constraint.humanId,
    requesterMembershipRevision: membership.revision,
    requesterAccessRevision: constraint.revocationEpoch,
    targetMembershipRevision: target.agent.membershipRevision,
    targetAccessRevision: target.agent.revocationEpoch,
  };
  const old = artifact.requestSources[input.messageEventId];
  if (old && !isDeepStrictEqual(old, source))
    throw new CollectiveServiceError(
      'COLLABORATION_OPERATION_CONFLICT',
      'Public source already names another shared request',
      409,
    );
  if (!old && Object.values(state.artifacts).filter((item) => item.requestSources[input.messageEventId]).length >= 12)
    throw new CollectiveServiceError(
      'ARTIFACT_BUSY',
      'This request already references the maximum number of works',
      429,
    );
  state.artifacts[artifact.artifactId] = {
    ...artifact,
    requestSources: { ...artifact.requestSources, [input.messageEventId]: source },
  };
}

export function readArtifactAgentContext(persistence: PersistentServiceState, credential: string, raw: unknown) {
  const input = collectiveArtifactAgentContextRequestSchema.parse(raw);
  const state = persistence.snapshot();
  requireParticipationSource(state, credential, input);
  const requests = [];
  for (const artifact of Object.values(state.artifacts)) {
    if (artifact.collectiveId !== input.collectiveId) continue;
    const bound = artifact.requestSources[input.eventId];
    if (!bound) continue;
    try {
      const { agent } = resolveArtifactRequestAgent(state, artifact, input.eventId);
      if (
        agent.connectionId !== input.connectionId ||
        agent.catId !== input.catId ||
        agent.participationRevision !== input.participationRevision
      )
        denyArtifact();
    } catch (error) {
      if (!(error instanceof CollectiveServiceError) || error.statusCode !== 403) throw error;
      return { status: 'access_denied' as const, requests: [] };
    }
    const adopted = artifact.versions.find((version) => version.lineage?.requestEventId === input.eventId);
    requests.push({
      artifactId: artifact.artifactId,
      title: artifact.title,
      contentRef: artifact.contentRef,
      sourceEventId: artifact.sourceEventId,
      requestEventId: bound.requestEventId,
      ownerRevision: bound.ownerRevision,
      blobDigest: bound.blobDigest,
      annotationIds: bound.annotationIds,
      ...(bound.selections ? { selections: bound.selections } : {}),
      ...(bound.rework ? { rework: bound.rework } : {}),
      expectedReviewRevision: bound.expectedReviewRevision,
      ...(adopted ? { adoption: adopted } : {}),
    });
  }
  return { status: 'available' as const, requests };
}

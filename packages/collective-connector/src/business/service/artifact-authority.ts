import type { CollectiveArtifactAction, CollectiveArtifactRecord } from '../contracts/index.js';
import { CollectiveServiceError } from './errors.js';
import { requireHumanAuthBinding, requireMembership, resolveSession } from './identity-store.js';
import type { ServiceState } from './state.js';

export function requireArtifactHuman(state: ServiceState, sessionToken: string, collectiveId: string) {
  const { human } = resolveSession(state, sessionToken);
  requireHumanAuthBinding(state, human.humanId);
  requireMembership(state, collectiveId, human.humanId);
  return human;
}
export function requireArtifact(state: ServiceState, collectiveId: string, artifactId: string) {
  const artifact = state.artifacts[artifactId];
  if (!artifact || artifact.collectiveId !== collectiveId)
    throw new CollectiveServiceError('ARTIFACT_NOT_FOUND', 'Shared work is unavailable', 404);
  return artifact;
}
export function artifactAccess(artifact: CollectiveArtifactRecord, humanId: string) {
  return artifact.access[humanId] ?? { revision: 1, status: 'active' as const, mayApply: false };
}
/** Membership/resource/action only. Custodian health cannot revoke another Human. */
export function requireArtifactAction(
  state: ServiceState,
  artifact: CollectiveArtifactRecord,
  humanId: string,
  action: CollectiveArtifactAction,
) {
  const membership = requireMembership(state, artifact.collectiveId, humanId);
  requireHumanAuthBinding(state, humanId);
  const access = artifactAccess(artifact, humanId);
  if (access.status === 'revoked' || (['apply', 'reject'].includes(action) && !access.mayApply)) denyArtifact();
  return membership;
}
export function requireArtifactManager(state: ServiceState, artifact: CollectiveArtifactRecord, humanId: string) {
  if (!artifactManagementRights(state, artifact, humanId).canManageAccess) denyArtifact();
}
export function artifactManagementRights(state: ServiceState, artifact: CollectiveArtifactRecord, humanId: string) {
  const steward = requireMembership(state, artifact.collectiveId, humanId).role === 'steward';
  const canManageAccess = artifact.publishedByHumanId === humanId || steward;
  return {
    canManageAccess,
    canManageCustody:
      canManageAccess || state.connections[artifact.custody.connectionId]?.authorizedHumanId === humanId,
  };
}
export function artifactCustodianAvailable(state: ServiceState, artifact: CollectiveArtifactRecord) {
  const connection = state.connections[artifact.custody.connectionId];
  return (
    artifact.custody.status === 'active' &&
    connection?.status === 'connected' &&
    connection.endpointId === artifact.custody.endpointId &&
    Boolean(connection.authorizedHumanId)
  );
}
export function requireArtifactCustodian(state: ServiceState, artifact: CollectiveArtifactRecord) {
  if (!artifactCustodianAvailable(state, artifact))
    throw new CollectiveServiceError(
      'ARTIFACT_OWNER_UNAVAILABLE',
      'The content owner is unavailable; try again after it reconnects',
      503,
    );
}
export function projectArtifact(state: ServiceState, artifact: CollectiveArtifactRecord, humanId: string) {
  const {
    custody: _custody,
    custodyHistory: _history,
    access: _access,
    pendingHandoff: _handoff,
    custodyTransfers: _transfers,
    requestSources: _requestSources,
    ...publicRecord
  } = artifact;
  const access = artifactAccess(artifact, humanId);
  return {
    ...publicRecord,
    versions: artifact.versions.slice(-1),
    versionCount: artifact.versions.length,
    accessRevision: access.revision,
    canApply: access.status === 'active' && access.mayApply,
    ...artifactManagementRights(state, artifact, humanId),
    availability: artifactCustodianAvailable(state, artifact) ? ('available' as const) : ('owner_unavailable' as const),
  };
}
export function denyArtifact(): never {
  throw new CollectiveServiceError('ARTIFACT_ACCESS_DENIED', 'Shared work access is no longer permitted', 403);
}

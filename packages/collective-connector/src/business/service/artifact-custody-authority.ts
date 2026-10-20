import { isDeepStrictEqual } from 'node:util';
import type {
  AcceptCollectiveArtifactCustody,
  CollectiveArtifactCustodyTransfer,
  CollectiveArtifactRecord,
} from '../contracts/index.js';
import {
  artifactManagementRights,
  denyArtifact,
  requireArtifact,
  requireArtifactAction,
  requireArtifactHuman,
} from './artifact-authority.js';
import { assertConnectionCoordinates, requireAuthorizedHuman, requireConnection } from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import { requireMembership } from './membership-authority.js';
import { secretMatches } from './persistence.js';
import type { ConnectionRecord, ServiceState } from './state.js';

export function requireCustodyManager(state: ServiceState, artifact: CollectiveArtifactRecord, session: string) {
  const human = requireArtifactHuman(state, session, artifact.collectiveId);
  if (!artifactManagementRights(state, artifact, human.humanId).canManageCustody) denyArtifact();
  return human;
}
export function requireCustodyDestination(
  state: ServiceState,
  artifact: CollectiveArtifactRecord,
  input: { targetHumanId: string; targetConnectionId?: string },
) {
  requireMembership(state, artifact.collectiveId, input.targetHumanId);
  requireArtifactAction(state, artifact, input.targetHumanId, 'read');
  const targets = Object.values(state.connections).filter(
    (connection) =>
      connection.collectiveId === artifact.collectiveId &&
      connection.authorizedHumanId === input.targetHumanId &&
      connection.status === 'connected' &&
      connection.connectionId !== artifact.custody.connectionId,
  );
  const target = input.targetConnectionId
    ? targets.find((connection) => connection.connectionId === input.targetConnectionId)
    : targets.length === 1
      ? targets[0]
      : undefined;
  if (!target)
    throw new CollectiveServiceError(
      'ARTIFACT_REVISION_CONFLICT',
      'Choose an available Café belonging to the destination Human',
      409,
    );
  return target;
}
export function requireCustodyTransfer(
  state: ServiceState,
  input: { collectiveId: string; artifactId: string; transferId: string },
) {
  const artifact = requireArtifact(state, input.collectiveId, input.artifactId);
  const transfer = artifact.custodyTransfers[input.transferId];
  if (!transfer || transfer.artifactId !== artifact.artifactId || transfer.collectiveId !== input.collectiveId)
    denyArtifact();
  return { artifact, transfer };
}
export function transferVersion(artifact: CollectiveArtifactRecord) {
  const version = artifact.versions.at(-1);
  if (!version) denyArtifact();
  return {
    contentRef: artifact.contentRef,
    ownerRevision: version.ownerRevision,
    blobDigest: version.blobDigest,
    receiptRef: version.receiptRef,
  };
}
export function requireCurrentTransfer(
  state: ServiceState,
  artifact: CollectiveArtifactRecord,
  transfer: CollectiveArtifactCustodyTransfer,
) {
  if (
    artifact.pendingHandoff?.handoffRef !== transfer.transferId ||
    artifact.custody.revision !== transfer.expectedCustodyRevision ||
    artifact.custody.connectionId !== transfer.sourceConnectionId
  )
    denyArtifact();
  const target = state.connections[transfer.targetConnectionId];
  if (
    !target ||
    target.status !== 'connected' ||
    target.endpointId !== transfer.targetEndpointId ||
    target.authorizedHumanId !== transfer.targetHumanId
  )
    denyArtifact();
  requireArtifactAction(state, artifact, transfer.targetHumanId, 'read');
}
/** Terminal metadata alone can be recovered by its exact retired endpoint credential; this never grants content access. */
export function requireTransferEndpoint(
  state: ServiceState,
  credential: string,
  input: { serviceInstanceId: string; collectiveId: string; connectionId: string },
  transfer: CollectiveArtifactCustodyTransfer,
) {
  const source = transfer.sourceConnectionId === input.connectionId;
  if (!source && transfer.targetConnectionId !== input.connectionId) denyArtifact();
  const terminal = ['committed', 'cancelled'].includes(transfer.state);
  const connection = terminal
    ? state.connections[input.connectionId]
    : requireConnection(state, credential, input.connectionId);
  if (
    !connection ||
    !secretMatches(credential, connection.credentialDigest) ||
    connection.endpointId !== (source ? transfer.sourceEndpointId : transfer.targetEndpointId)
  )
    denyArtifact();
  assertConnectionCoordinates(state, connection, input);
  if (!terminal) {
    if (connection.authorizedHumanId !== (source ? transfer.sourceHumanId : transfer.targetHumanId)) denyArtifact();
    requireAuthorizedHuman(state, connection);
  }
  return source ? ('source' as const) : ('target' as const);
}
export function custodyHandoffRequired(): never {
  throw new CollectiveServiceError(
    'ARTIFACT_CUSTODY_HANDOFF_REQUIRED',
    'Complete owner preparation and verified target readiness before committing custody',
    409,
  );
}

export function requireTargetActivation(
  state: ServiceState,
  artifact: CollectiveArtifactRecord,
  transfer: CollectiveArtifactCustodyTransfer,
  credential: string,
) {
  const connection = requireConnection(state, credential, transfer.targetConnectionId);
  const human = requireAuthorizedHuman(state, connection);
  if (
    human.humanId !== transfer.targetHumanId ||
    connection.endpointId !== transfer.targetEndpointId ||
    artifact.custody.connectionId !== transfer.targetConnectionId ||
    artifact.custody.revision !== transfer.expectedCustodyRevision + 1
  )
    denyArtifact();
  requireArtifactAction(state, artifact, human.humanId, 'read');
}
export function artifactEffectsFrozen(artifact: CollectiveArtifactRecord): boolean {
  const transfer = artifact.pendingHandoff && artifact.custodyTransfers[artifact.pendingHandoff.handoffRef];
  return Boolean(transfer && ['source_prepared', 'target_ready'].includes(transfer.state));
}
export function assertArtifactEffectAvailable(artifact: CollectiveArtifactRecord, effect: boolean) {
  if (effect && artifactEffectsFrozen(artifact))
    throw new CollectiveServiceError(
      'ARTIFACT_OWNER_UNAVAILABLE',
      'Work custody is being transferred; retry after completion',
      503,
    );
}

export function requireReadyCustodyCommit(
  state: ServiceState,
  artifact: CollectiveArtifactRecord,
  input: AcceptCollectiveArtifactCustody,
  connection: ConnectionRecord,
) {
  const transfer = artifact.custodyTransfers[input.handoffRef];
  if (!transfer?.prepared || !transfer.ready || !input.preparedRef || !input.readyRef) custodyHandoffRequired();
  if (
    transfer.targetConnectionId !== connection.connectionId ||
    transfer.targetEndpointId !== connection.endpointId ||
    transfer.targetHumanId !== connection.authorizedHumanId
  )
    denyArtifact();
  if (
    input.preparedRef !== transfer.prepared.preparedRef ||
    input.readyRef !== transfer.ready.readyRef ||
    input.ownerScopeRef !== transfer.ready.ownerScopeRef
  )
    custodyHandoffRequired();
  const version = {
    contentRef: input.contentRef,
    ownerRevision: input.ownerRevision,
    blobDigest: input.blobDigest,
    receiptRef: input.receiptRef,
  };
  if (
    input.expectedCustodyRevision !== transfer.expectedCustodyRevision ||
    !isDeepStrictEqual(version, transfer.version)
  )
    denyArtifact();
  if (transfer.state !== 'committed') {
    requireCurrentTransfer(state, artifact, transfer);
    if (
      transfer.state !== 'target_ready' ||
      artifact.pendingHandoff?.targetConnectionId !== connection.connectionId ||
      !isDeepStrictEqual(version, transferVersion(artifact))
    )
      custodyHandoffRequired();
  }
  return transfer;
}

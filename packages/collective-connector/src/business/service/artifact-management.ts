import { createHash } from 'node:crypto';
import { collectiveArtifactManagementSchema, readCollectiveArtifactManagementSchema } from '../contracts/index.js';
import {
  artifactAccess,
  artifactCustodianAvailable,
  artifactManagementRights,
  denyArtifact,
  requireArtifact,
  requireArtifactHuman,
} from './artifact-authority.js';
import { assertServiceCoordinates } from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import type { ServiceState } from './state.js';

export function readArtifactManagement(state: ServiceState, session: string, unsafe: unknown) {
  const input = readCollectiveArtifactManagementSchema.parse(unsafe);
  assertServiceCoordinates(state, input.serviceInstanceId, input.collectiveId);
  const human = requireArtifactHuman(state, session, input.collectiveId);
  const artifact = requireArtifact(state, input.collectiveId, input.artifactId);
  const rights = artifactManagementRights(state, artifact, human.humanId);
  if (!rights.canManageAccess && !rights.canManageCustody) denyArtifact();
  const cafes = Object.values(state.connections).filter(
    (connection) => connection.collectiveId === input.collectiveId && connection.status === 'connected',
  );
  const members = Object.values(state.memberships)
    .filter((membership) => membership.collectiveId === input.collectiveId && membership.status === 'active')
    .map((membership) => {
      const member = state.humans[membership.humanId];
      if (!member) denyArtifact();
      const access = artifactAccess(artifact, membership.humanId);
      const targets = cafes.filter(
        (connection) =>
          connection.authorizedHumanId === membership.humanId &&
          connection.connectionId !== artifact.custody.connectionId,
      );
      return {
        humanId: membership.humanId,
        displayName: member.displayName,
        ...(rights.canManageAccess
          ? {
              access:
                access.status === 'revoked'
                  ? ('revoked' as const)
                  : access.mayApply
                    ? ('apply' as const)
                    : ('read' as const),
              accessRevision: access.revision,
            }
          : {}),
        canReceiveCustody: rights.canManageCustody && access.status === 'active' && targets.length > 0,
      };
    })
    .sort((a, b) => a.humanId.localeCompare(b.humanId));
  const transfers = Object.values(artifact.custodyTransfers);
  const transfer =
    transfers.find((item) => item.transferId === artifact.pendingHandoff?.handoffRef) ??
    transfers.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  const snapshot = `sha256:${createHash('sha256')
    .update(
      JSON.stringify([
        members,
        artifact.custody,
        transfer,
        cafes
          .map((cafe) => [cafe.connectionId, cafe.authorizedHumanId, cafe.endpointLabel])
          .sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? '')),
      ]),
    )
    .digest('hex')}`;
  const custodian = state.connections[artifact.custody.connectionId];
  const destination = transfer && state.connections[transfer.targetConnectionId];
  if ((input.offset > 0 && !input.snapshot) || (input.snapshot && input.snapshot !== snapshot))
    throw new CollectiveServiceError(
      'ARTIFACT_REVISION_CONFLICT',
      'Management changed; refresh before reading another page',
      409,
    );
  return collectiveArtifactManagementSchema.parse({
    serviceInstanceId: input.serviceInstanceId,
    collectiveId: input.collectiveId,
    artifactId: artifact.artifactId,
    ...rights,
    custodyRevision: artifact.custody.revision,
    custodianHumanId: custodian?.authorizedHumanId,
    ...(custodian
      ? { custodianCafe: { connectionId: custodian.connectionId, endpointLabel: custodian.endpointLabel } }
      : {}),
    custodyAvailable: artifactCustodianAvailable(state, artifact),
    snapshot,
    offset: input.offset,
    total: members.length,
    ...(input.offset + input.limit < members.length ? { nextOffset: input.offset + input.limit } : {}),
    members: members.slice(input.offset, input.offset + input.limit),
    ...(transfer
      ? {
          transfer: {
            transferId: transfer.transferId,
            state: transfer.state,
            sourceHumanId: transfer.sourceHumanId,
            targetHumanId: transfer.targetHumanId,
            ...(destination
              ? { targetCafe: { connectionId: destination.connectionId, endpointLabel: destination.endpointLabel } }
              : {}),
            sourceFinalized: transfer.sourceFinalized,
            targetFinalized: transfer.targetFinalized,
            updatedAt: transfer.updatedAt,
          },
        }
      : {}),
  });
}

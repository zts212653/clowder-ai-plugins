import { acceptCollectiveArtifactCustodySchema, offerCollectiveArtifactCustodySchema } from '../contracts/index.js';
import {
  artifactAccess,
  denyArtifact,
  projectArtifact,
  requireArtifact,
  requireArtifactHuman,
} from './artifact-authority.js';
import {
  custodyHandoffRequired,
  requireCustodyDestination,
  requireCustodyManager,
  requireReadyCustodyCommit,
  transferVersion,
} from './artifact-custody-authority.js';
import { CollectiveArtifactCustodyTransfer } from './artifact-custody-transfer.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import {
  assertConnectionCoordinates,
  assertServiceCoordinates,
  requireAuthorizedHuman,
  requireConnection,
} from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import { createSecret, type PersistentServiceState } from './persistence.js';

/** Custody changes require a Human offer plus a matching authenticated destination-owner attestation. */
export class CollectiveArtifactCustody {
  readonly transfers: CollectiveArtifactCustodyTransfer;
  constructor(
    private readonly persistence: PersistentServiceState,
    private readonly now: () => number,
  ) {
    this.transfers = new CollectiveArtifactCustodyTransfer(persistence, now);
  }
  async offer(sessionToken: string, unsafeInput: unknown) {
    const input = offerCollectiveArtifactCustodySchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      assertServiceCoordinates(state, input.serviceInstanceId, input.collectiveId);
      const human = requireArtifactHuman(state, sessionToken, input.collectiveId);
      const artifact = requireArtifact(state, input.collectiveId, input.artifactId);
      requireCustodyManager(state, artifact, sessionToken);
      const custodian = state.connections[artifact.custody.connectionId];
      const operation = collaborationOperationReplay(state, {
        ...input,
        actorScope: `human:${human.humanId}`,
        payload: input,
        resourceKind: 'artifact',
      });
      if (operation.existing) {
        const previous = Object.values(artifact.custodyTransfers).find(
          (transfer) => transfer.offerRequestId === input.requestId && transfer.offeredByHumanId === human.humanId,
        );
        if (!previous) custodyHandoffRequired();
        return { handoffRef: previous.transferId };
      }
      if (artifact.custody.revision !== input.expectedCustodyRevision || artifact.pendingHandoff)
        throw new CollectiveServiceError(
          'ARTIFACT_REVISION_CONFLICT',
          'Work custody changed or a handoff is pending',
          409,
        );
      if (artifact.custodyHistory.length >= 10000)
        throw new CollectiveServiceError('ARTIFACT_REVISION_CONFLICT', 'Custody history capacity reached', 409);
      const target = requireCustodyDestination(state, artifact, input);
      const at = new Date(this.now()).toISOString();
      const pending = {
        handoffRef: `artifact-handoff:${createSecret()}`,
        targetConnectionId: target.connectionId,
        expectedCustodyRevision: artifact.custody.revision,
        offeredByHumanId: human.humanId,
        createdAt: at,
      };
      if (!custodian?.authorizedHumanId) denyArtifact();
      const transfer = {
        v: 1 as const,
        transferId: pending.handoffRef,
        serviceInstanceId: state.serviceInstanceId,
        collectiveId: artifact.collectiveId,
        artifactId: artifact.artifactId,
        sourceEventId: artifact.sourceEventId,
        publishedByHumanId: artifact.publishedByHumanId,
        sourceConnectionId: custodian.connectionId,
        sourceEndpointId: custodian.endpointId,
        sourceHumanId: custodian.authorizedHumanId,
        targetConnectionId: target.connectionId,
        targetEndpointId: target.endpointId,
        targetHumanId: input.targetHumanId,
        expectedCustodyRevision: artifact.custody.revision,
        state: 'offered' as const,
        version: transferVersion(artifact),
        offeredByHumanId: human.humanId,
        offerRequestId: input.requestId,
        createdAt: at,
        updatedAt: at,
        sourceFinalized: false,
        targetFinalized: false,
      };
      state.artifacts[artifact.artifactId] = {
        ...artifact,
        pendingHandoff: pending,
        custodyTransfers: { ...artifact.custodyTransfers, [transfer.transferId]: transfer },
        updatedAt: at,
      };
      recordCollaborationOperation(state, {
        ...operation,
        actorScope: `human:${human.humanId}`,
        resourceKind: 'artifact',
        resourceId: artifact.artifactId,
        revision: artifact.custody.revision,
        recordedAt: at,
      });
      return { handoffRef: pending.handoffRef };
    });
  }
  async accept(credential: string, unsafeInput: unknown) {
    const input = acceptCollectiveArtifactCustodySchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const connection = requireConnection(state, credential, input.connectionId);
      assertConnectionCoordinates(state, connection, input);
      const human = requireAuthorizedHuman(state, connection);
      const artifact = requireArtifact(state, input.collectiveId, input.artifactId);
      const transfer = requireReadyCustodyCommit(state, artifact, input, connection);
      const operation = collaborationOperationReplay(state, {
        ...input,
        actorScope: `connection:${connection.connectionId}`,
        payload: input,
        resourceKind: 'artifact',
      });
      if (operation.existing) return projectArtifact(state, artifact, human.humanId);
      if (transfer.state === 'committed') return projectArtifact(state, artifact, human.humanId);
      const { pendingHandoff: _pending, ...previous } = artifact;
      const updated = {
        ...previous,
        custody: {
          connectionId: connection.connectionId,
          endpointId: connection.endpointId,
          revision: artifact.custody.revision + 1,
          status: 'suspended' as const,
          ownerScopeRef: input.ownerScopeRef,
        },
        custodyHistory: [...artifact.custodyHistory, artifact.custody],
        custodyTransfers: {
          ...artifact.custodyTransfers,
          [transfer.transferId]: {
            ...transfer,
            state: 'committed' as const,
            updatedAt: new Date(this.now()).toISOString(),
          },
        },
        access: Object.fromEntries(
          [
            ...new Set([
              ...Object.keys(artifact.access),
              ...Object.values(state.memberships)
                .filter((member) => member.collectiveId === artifact.collectiveId)
                .map((member) => member.humanId),
            ]),
          ].map((humanId) => [
            humanId,
            { ...artifactAccess(artifact, humanId), revision: artifactAccess(artifact, humanId).revision + 1 },
          ]),
        ),
        revision: artifact.revision + 1,
        updatedAt: new Date(this.now()).toISOString(),
      };
      state.artifacts[artifact.artifactId] = updated;
      recordCollaborationOperation(state, {
        ...operation,
        actorScope: `connection:${connection.connectionId}`,
        resourceKind: 'artifact',
        resourceId: artifact.artifactId,
        revision: updated.custody.revision,
        recordedAt: updated.updatedAt,
      });
      return projectArtifact(state, updated, human.humanId);
    });
  }
}

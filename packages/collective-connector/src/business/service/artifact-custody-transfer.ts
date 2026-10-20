import { isDeepStrictEqual } from 'node:util';
import {
  authorizeCollectiveCustodySchema,
  type CollectiveArtifactCustodyTransfer as CollectiveCustodyTransferRecord,
  cancelCollectiveCustodySchema,
  collectiveCustodyEndpointSchema,
  collectiveCustodyTargetSchema,
  finalizeCollectiveCustodySchema,
  prepareCollectiveCustodySchema,
  readyCollectiveCustodySchema,
} from '../contracts/index.js';
import { denyArtifact } from './artifact-authority.js';
import {
  custodyHandoffRequired,
  requireCurrentTransfer,
  requireCustodyManager,
  requireCustodyTransfer,
  requireTargetActivation,
  requireTransferEndpoint,
  transferVersion,
} from './artifact-custody-authority.js';
import {
  assertConnectionCoordinates,
  assertServiceCoordinates,
  requireAuthorizedHuman,
  requireConnection,
} from './connection-authority.js';
import type { PersistentServiceState } from './persistence.js';
import type { ServiceState } from './state.js';

const ownerPhases: Record<
  'prepareSource' | 'readPage' | 'stageTarget' | 'attestReady',
  { side: 'source' | 'target'; phases: readonly CollectiveCustodyTransferRecord['state'][] }
> = {
  prepareSource: { side: 'source', phases: ['offered'] },
  readPage: { side: 'source', phases: ['source_prepared', 'target_ready'] },
  stageTarget: { side: 'target', phases: ['source_prepared'] },
  attestReady: { side: 'target', phases: ['source_prepared'] },
};

function* pendingTransfers(state: ServiceState, input: { collectiveId: string; connectionId: string }) {
  for (const artifact of Object.values(state.artifacts)) {
    if (artifact.collectiveId !== input.collectiveId) continue;
    for (const transfer of Object.values(artifact.custodyTransfers)) {
      const source = transfer.sourceConnectionId === input.connectionId;
      if (
        (!source && transfer.targetConnectionId !== input.connectionId) ||
        (source ? transfer.sourceFinalized : transfer.targetFinalized)
      )
        continue;
      yield { artifact, transfer };
    }
  }
}

/** All persisted state is content-free. Owner pages use a separate bounded ephemeral relay. */
export class CollectiveArtifactCustodyTransfer {
  constructor(
    private readonly persistence: PersistentServiceState,
    private readonly now: () => number,
  ) {}
  async prepare(credential: string, raw: unknown) {
    const input = prepareCollectiveCustodySchema.parse(raw);
    return this.persistence.transaction((state) => {
      const { artifact, transfer } = requireCustodyTransfer(state, input);
      if (requireTransferEndpoint(state, credential, input, transfer) !== 'source') denyArtifact();
      if (transfer.prepared) {
        if (!isDeepStrictEqual(transfer.prepared, input.proof)) denyArtifact();
        return transfer;
      }
      requireCurrentTransfer(state, artifact, transfer);
      if (transfer.state !== 'offered' || !isDeepStrictEqual(transferVersion(artifact), input.proof.version))
        custodyHandoffRequired();
      const next = {
        ...transfer,
        state: 'source_prepared' as const,
        prepared: input.proof,
        version: input.proof.version,
        updatedAt: new Date(this.now()).toISOString(),
      };
      artifact.custodyTransfers[transfer.transferId] = next;
      return next;
    });
  }
  async ready(credential: string, raw: unknown) {
    const input = readyCollectiveCustodySchema.parse(raw);
    return this.persistence.transaction((state) => {
      const { artifact, transfer } = requireCustodyTransfer(state, input);
      if (requireTransferEndpoint(state, credential, input, transfer) !== 'target') denyArtifact();
      if (transfer.ready) {
        if (!isDeepStrictEqual(transfer.ready, input.proof)) denyArtifact();
        return transfer;
      }
      requireCurrentTransfer(state, artifact, transfer);
      const prepared = transfer.prepared;
      if (transfer.state !== 'source_prepared' || !prepared) custodyHandoffRequired();
      if (
        input.proof.preparedRef !== prepared.preparedRef ||
        input.proof.manifestDigest !== prepared.manifest.digest ||
        input.proof.ownerScopeRef !== prepared.ownerScopeRef ||
        !isDeepStrictEqual(transferVersion(artifact), prepared.version)
      )
        denyArtifact();
      const next = {
        ...transfer,
        state: 'target_ready' as const,
        ready: input.proof,
        updatedAt: new Date(this.now()).toISOString(),
      };
      artifact.custodyTransfers[transfer.transferId] = next;
      return next;
    });
  }
  async cancel(session: string, raw: unknown) {
    const input = cancelCollectiveCustodySchema.parse(raw);
    return this.persistence.transaction((state) => {
      assertServiceCoordinates(state, input.serviceInstanceId, input.collectiveId);
      const { artifact, transfer } = requireCustodyTransfer(state, input);
      requireCustodyManager(state, artifact, session);
      if (transfer.state === 'committed') custodyHandoffRequired();
      if (transfer.state === 'cancelled') return transfer;
      if (
        artifact.pendingHandoff?.handoffRef !== transfer.transferId ||
        artifact.custody.connectionId !== transfer.sourceConnectionId ||
        artifact.custody.revision !== transfer.expectedCustodyRevision
      )
        custodyHandoffRequired();
      const next = { ...transfer, state: 'cancelled' as const, updatedAt: new Date(this.now()).toISOString() };
      artifact.custodyTransfers[transfer.transferId] = next;
      delete artifact.pendingHandoff;
      return next;
    });
  }
  read(credential: string, raw: unknown) {
    const input = collectiveCustodyTargetSchema.parse(raw);
    const state = this.persistence.snapshot();
    const { artifact, transfer } = requireCustodyTransfer(state, input);
    requireTransferEndpoint(state, credential, input, transfer);
    return transfer.state === 'offered' ? { ...transfer, version: transferVersion(artifact) } : transfer;
  }
  poll(credential: string, raw: unknown) {
    const input = collectiveCustodyEndpointSchema.parse(raw);
    const state = this.persistence.snapshot();
    const transfers = [];
    for (const { artifact, transfer } of pendingTransfers(state, input)) {
      requireTransferEndpoint(state, credential, input, transfer);
      transfers.push(transfer.state === 'offered' ? { ...transfer, version: transferVersion(artifact) } : transfer);
      if (transfers.length === 2) return transfers;
    }
    // Even an empty poll authenticates its endpoint; it cannot probe for arbitrary connection IDs.
    if (transfers.length) return transfers;
    const connection = requireConnection(state, credential, input.connectionId);
    assertConnectionCoordinates(state, connection, input);
    requireAuthorizedHuman(state, connection);
    return transfers;
  }
  async finalize(credential: string, raw: unknown) {
    const input = finalizeCollectiveCustodySchema.parse(raw);
    return this.persistence.transaction((state) => {
      const { artifact, transfer } = requireCustodyTransfer(state, input);
      const side = requireTransferEndpoint(state, credential, input, transfer);
      if (transfer.state !== input.outcome) custodyHandoffRequired();
      if (side === 'source' ? transfer.sourceFinalized : transfer.targetFinalized) return transfer;
      if (side === 'target' && transfer.state === 'committed') {
        requireTargetActivation(state, artifact, transfer, credential);
        artifact.custody.status = 'active';
      }
      const next = { ...transfer, [side === 'source' ? 'sourceFinalized' : 'targetFinalized']: true };
      artifact.custodyTransfers[transfer.transferId] = next;
      return next;
    });
  }
  authorize(credential: string, raw: unknown) {
    const input = authorizeCollectiveCustodySchema.parse(raw);
    const state = this.persistence.snapshot();
    const { artifact, transfer } = requireCustodyTransfer(state, input);
    const side = requireTransferEndpoint(state, credential, input, transfer);
    if (input.operation === 'finalize') {
      if (!['committed', 'cancelled'].includes(transfer.state)) custodyHandoffRequired();
      if (side === 'target' && transfer.state === 'committed')
        requireTargetActivation(state, artifact, transfer, credential);
      return transfer;
    }
    requireCurrentTransfer(state, artifact, transfer);
    const policy = ownerPhases[input.operation];
    if (side !== policy.side || !policy.phases.includes(transfer.state)) custodyHandoffRequired();
    return input.operation === 'prepareSource' ? { ...transfer, version: transferVersion(artifact) } : transfer;
  }
}

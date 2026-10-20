import type { CollectiveArtifactCustodyTransfer } from '../contracts/index.js';
import type { CollectiveArtifactCustodyClient } from './artifact-custody-client.js';
import type {
  CollectiveArtifactCustodyTransferPort,
  CollectiveCustodyOwnerAuthority,
} from './artifact-custody-owner-port.js';
import type { ConnectorPersistence } from './persistence.js';
import { ConnectorTransportError } from './service-client.js';
import { unavailable, workCoordinates } from './work-policy-custody.js';

/** Cursor is only a traffic optimization. Restart starts from zero; durable owner staging replays exact pages. */
export class ConnectorArtifactCustodyRelay {
  private readonly cursors = new Map<string, number>();
  constructor(
    private readonly persistence: ConnectorPersistence,
    private readonly client: CollectiveArtifactCustodyClient,
  ) {}
  async sync(connectionId: string, owner: CollectiveArtifactCustodyTransferPort) {
    const connection = this.connection(connectionId);
    const coordinates = workCoordinates(connection);
    let transfers: CollectiveArtifactCustodyTransfer[];
    try {
      transfers = await this.client.poll(connection.serviceUrl, connection.endpointCredential, coordinates);
    } catch (error) {
      // Legacy Services keep their communication contract without this separate capability.
      if (error instanceof ConnectorTransportError && error.statusCode === 404 && error.code === 'NOT_FOUND') return;
      throw error;
    }
    // Serving incoming page RPCs comes first; they never wait for this Cafe's own target transfer work.
    for (const operation of await this.client.pollPages(
      connection.serviceUrl,
      connection.endpointCredential,
      coordinates,
    )) {
      let result: Parameters<CollectiveArtifactCustodyClient['respondPage']>[4];
      try {
        if (operation.expiresAt <= Date.now()) throw unavailable();
        const page = await owner.readPage(
          operation.transfer,
          operation.index,
          this.authority(connectionId, operation.transfer),
        );
        result = { status: 'ok', page };
      } catch {
        result = { status: 'error', error: 'owner_unavailable' };
      }
      await this.client
        .respondPage(connection.serviceUrl, connection.endpointCredential, coordinates, operation.relayRef, result)
        .catch((error) => {
          if (!(error instanceof ConnectorTransportError) || error.retryable) throw error;
        });
    }
    for (const transfer of transfers) await this.advance(connectionId, owner, transfer);
  }
  private async advance(
    connectionId: string,
    owner: CollectiveArtifactCustodyTransferPort,
    transfer: CollectiveArtifactCustodyTransfer,
  ) {
    const connection = this.connection(connectionId);
    const coordinates = {
      ...workCoordinates(connection),
      artifactId: transfer.artifactId,
      transferId: transfer.transferId,
    };
    const authority = this.authority(connectionId, transfer);
    const { serviceUrl, endpointCredential } = connection;
    if (transfer.state === 'committed' || transfer.state === 'cancelled') {
      await owner.finalize(transfer, authority);
      await this.client.finalized(serviceUrl, endpointCredential, coordinates, transfer.state);
      this.cursors.delete(transfer.transferId);
      return;
    }
    if (connectionId === transfer.sourceConnectionId) {
      if (transfer.state === 'offered') {
        const proof = await owner.prepareSource(transfer, authority);
        await this.client.prepared(serviceUrl, endpointCredential, coordinates, proof);
      }
      return;
    }
    if (transfer.state === 'source_prepared') {
      if (!transfer.prepared) throw unavailable();
      const index = this.cursors.get(transfer.transferId) ?? 0;
      if (index < transfer.prepared.manifest.pageCount) {
        const page = await this.client.requestPage(serviceUrl, endpointCredential, coordinates, index);
        await owner.stageTarget(transfer, page, authority);
        this.cursors.set(transfer.transferId, index + 1);
        if (index + 1 < transfer.prepared.manifest.pageCount) return;
      }
      const proof = await owner.attestReady(transfer, authority);
      transfer = await this.client.ready(serviceUrl, endpointCredential, coordinates, proof);
    }
    if (transfer.state === 'target_ready') {
      const committed = await this.client.commit(serviceUrl, endpointCredential, coordinates, transfer);
      await owner.finalize(committed, authority);
      await this.client.finalized(serviceUrl, endpointCredential, coordinates, 'committed');
      this.cursors.delete(transfer.transferId);
    }
  }
  private authority(
    connectionId: string,
    transfer: CollectiveArtifactCustodyTransfer,
  ): CollectiveCustodyOwnerAuthority {
    return {
      authorize: async (operation) => {
        const connection = this.connection(connectionId);
        return this.client.authorize(
          connection.serviceUrl,
          connection.endpointCredential,
          { ...workCoordinates(connection), artifactId: transfer.artifactId, transferId: transfer.transferId },
          operation,
        );
      },
    };
  }
  private connection(connectionId: string) {
    const connection = this.persistence.snapshot().connections[connectionId];
    if (!connection || connection.authorityStatus !== 'connected' || !connection.endpointCredential)
      throw unavailable();
    return { ...connection, endpointCredential: connection.endpointCredential };
  }
}

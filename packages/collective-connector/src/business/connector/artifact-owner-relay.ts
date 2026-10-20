import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  COLLECTIVE_MEDIA_CUSTODY_PROOF_CONTEXT,
  type CollectiveRetainedMediaRegistrationRequest,
  type RegisterCollectiveArtifact,
} from '../contracts/index.js';
import { ConnectorArtifactCustodyRelay } from './artifact-custody-relay.js';
import { ConnectorArtifactMediaRelay } from './artifact-media-relay.js';
import type { CollectiveArtifactOwnerPort, CollectiveArtifactOwnerResult } from './artifact-owner-client.js';
import { recoverPublications } from './artifact-publication-recovery.js';
import { syncArtifactPublications } from './artifact-publication-relay.js';
import type { ConnectorPersistence } from './persistence.js';
import type { CollectiveServiceClient } from './service-client.js';
import { ConnectorTransportError } from './service-client.js';
import { unavailable, workCoordinates } from './work-policy-custody.js';

export class ConnectorArtifactOwnerRelay {
  private owner: CollectiveArtifactOwnerPort | undefined;
  private readonly custody: ConnectorArtifactCustodyRelay;
  readonly media: ConnectorArtifactMediaRelay;
  constructor(
    private readonly persistence: ConnectorPersistence,
    private readonly service: CollectiveServiceClient,
  ) {
    this.custody = new ConnectorArtifactCustodyRelay(persistence, service.custody);
    this.media = new ConnectorArtifactMediaRelay(persistence, service);
  }
  setOwner(owner: CollectiveArtifactOwnerPort | undefined) {
    this.owner = owner;
    this.media.setOwner(owner?.media, owner !== undefined);
  }
  async register(
    connectionId: string,
    ownerUserId: string,
    input: Omit<RegisterCollectiveArtifact, 'serviceInstanceId' | 'collectiveId' | 'connectionId'>,
  ) {
    const connection = this.connection(connectionId);
    if (this.persistence.snapshot().hostRoutes[connectionId]?.localOwnerUserId !== ownerUserId) throw unavailable();
    const registration = { ...input, ...workCoordinates(connection) };
    if (['image/png', 'video/mp4'].includes(input.mediaType)) {
      const client = this.service.artifacts;
      const proof = createHash('sha256')
        .update(COLLECTIVE_MEDIA_CUSTODY_PROOF_CONTEXT)
        .update('\0')
        .update(connection.endpointCredential)
        .digest('hex');
      await this.persistence.transaction((state) => {
        const fresh = state.connections[connectionId];
        if (!fresh || fresh.authorityStatus !== 'connected') throw unavailable();
        fresh.custodyRecoveryCredential = proof;
      });
      const prepared = await client.recoverMediaCustody(
        connection.serviceUrl,
        connection.endpointCredential,
        registration,
      );
      if (prepared.status === 'rebound') return prepared.artifact;
      if (prepared.status === 'proof_required') {
        const previous = this.persistence.snapshot().connections[prepared.previousConnectionId];
        const secret = previous?.custodyRecoveryCredential;
        if (
          !secret ||
          previous.serviceInstanceId !== connection.serviceInstanceId ||
          previous.collectiveId !== connection.collectiveId ||
          previous.authorizedHumanId !== connection.authorizedHumanId
        )
          throw unavailable();
        const rebound = await client.recoverMediaCustody(connection.serviceUrl, connection.endpointCredential, {
          ...registration,
          previousConnectionId: previous.connectionId,
          previousCustodyProof: secret,
        });
        if (rebound.status !== 'rebound') throw unavailable();
        return rebound.artifact;
      }
    }
    return this.service.artifacts.register(connection.serviceUrl, connection.endpointCredential, registration);
  }
  async registrationContext(
    connectionId: string,
    ownerUserId: string,
    input: Omit<CollectiveRetainedMediaRegistrationRequest, 'serviceInstanceId' | 'collectiveId' | 'connectionId'>,
  ) {
    const connection = this.connection(connectionId);
    if (this.persistence.snapshot().hostRoutes[connectionId]?.localOwnerUserId !== ownerUserId)
      throw new ConnectorTransportError('The local Human does not own this Cafe', 403, 'ARTIFACT_ACCESS_DENIED');
    return this.service.artifacts.registrationContext(connection.serviceUrl, connection.endpointCredential, {
      ...input,
      ...workCoordinates(connection),
    });
  }
  recoverPublications(connectionId: string) {
    return recoverPublications(this.persistence, this.service.artifacts, connectionId, this.owner);
  }
  async sync(connectionId: string) {
    const owner = this.owner;
    if (!owner) return;
    const connection = this.connection(connectionId);
    const coordinates = workCoordinates(connection);
    const client = this.service.artifacts;
    await syncArtifactPublications(this.persistence, client, connectionId, owner);
    const operations = await client.poll(connection.serviceUrl, connection.endpointCredential, coordinates);
    for (const operation of operations) {
      const reauthorize = async () => {
        this.connection(connectionId);
        const fresh = await client.reauthorize(
          connection.serviceUrl,
          connection.endpointCredential,
          coordinates,
          operation,
        );
        if (!isDeepStrictEqual(fresh, operation.constraint)) throw unavailable();
        return fresh;
      };
      let result: CollectiveArtifactOwnerResult;
      try {
        await reauthorize();
        result = await owner.execute(operation, { reauthorize });
        await reauthorize();
      } catch (error) {
        result = { status: 'error', error: { code: errorCode(error) } };
      }
      // Lost responses are deliberately not persisted. The owner replays the same request id/receipt.
      await client
        .respond(connection.serviceUrl, connection.endpointCredential, coordinates, operation.relayRef, result)
        .catch((error: unknown) => {
          if (!(error instanceof ConnectorTransportError) || error.retryable) throw error;
        });
    }
    if (owner.custody) await this.custody.sync(connectionId, owner.custody);
  }
  private connection(connectionId: string) {
    const connection = this.persistence.snapshot().connections[connectionId];
    if (!connection || connection.authorityStatus !== 'connected' || !connection.endpointCredential)
      throw unavailable();
    return { ...connection, endpointCredential: connection.endpointCredential };
  }
}

function errorCode(error: unknown): 'access_denied' | 'conflict' | 'owner_unavailable' {
  if (error instanceof ConnectorTransportError && error.statusCode === 403) return 'access_denied';
  if (error instanceof ConnectorTransportError && error.statusCode === 409) return 'conflict';
  return 'owner_unavailable';
}

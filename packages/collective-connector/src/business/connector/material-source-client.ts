import { z } from 'zod';
import {
  collectiveMaterialOperationSchema,
  collectiveMaterialPublicationSchema,
  type CollectiveMaterialSourcePort,
} from '../contracts/types/collective-material.js';
import type { ConnectorPersistence } from './persistence.js';
import type { CollectiveServiceClient } from './service-client.js';
import { unavailable, workCoordinates } from './work-policy-custody.js';

export class ConnectorMaterialSourceRelay {
  owner?: CollectiveMaterialSourcePort;
  constructor(
    private readonly persistence: ConnectorPersistence,
    private readonly service: CollectiveServiceClient,
  ) {}
  async sync(connectionId: string) {
    const owner = this.owner;
    if (!owner) return;
    const connection = this.connection(connectionId),
      coordinates = workCoordinates(connection);
    const request = (action: 'poll' | 'validate' | 'respond', extra: Record<string, unknown> = {}) => {
      this.connection(connectionId);
      return this.service.materialOwnerRequest(connection.serviceUrl, connection.endpointCredential, action, {
        ...coordinates,
        ...extra,
      });
    };
    const { operations } = z
      .object({ operations: z.array(collectiveMaterialOperationSchema).max(8) })
      .strict()
      .parse(await request('poll'));
    for (const operation of operations) {
      const published = operation.publication;
      if (
        published.serviceInstanceId !== connection.serviceInstanceId ||
        published.collectiveId !== connection.collectiveId ||
        published.connectionId !== connection.connectionId ||
        published.humanId !== connection.authorizedHumanId
      )
        throw unavailable();
      const reauthorize = async () => {
        const current = this.connection(connectionId);
        if (this.owner !== owner || current.endpointCredential !== connection.endpointCredential) throw unavailable();
        const publication = collectiveMaterialPublicationSchema.parse(
          (await request('validate', { relayRef: operation.relayRef })).publication,
        );
        const expected = operation.publication;
        for (const key of [
          'serviceInstanceId',
          'collectiveId',
          'connectionId',
          'humanId',
          'publicationId',
          'roadmapId',
          'channelId',
          'sourceEventId',
          'provider',
          'sourceId',
        ] as const)
          if (publication[key] !== expected[key]) throw unavailable();
        return publication;
      };
      let result: Awaited<ReturnType<CollectiveMaterialSourcePort['execute']>>;
      try {
        await reauthorize();
        result = await owner.execute(operation, { reauthorize });
        await reauthorize();
      } catch {
        result = { status: 'unavailable', reason: 'owner_unavailable' };
      }
      await request('respond', { relayRef: operation.relayRef, result }).catch(() => undefined);
    }
  }
  private connection(connectionId: string) {
    const connection = this.persistence.snapshot().connections[connectionId];
    if (!connection || connection.authorityStatus !== 'connected' || !connection.endpointCredential)
      throw unavailable();
    return { ...connection, endpointCredential: connection.endpointCredential };
  }
}

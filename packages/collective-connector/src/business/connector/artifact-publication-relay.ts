import { isDeepStrictEqual } from 'node:util';
import type {
  CollectiveArtifactOwnerClient,
  CollectiveArtifactOwnerPort,
  CollectiveArtifactOwnerResult,
} from './artifact-owner-client.js';
import { retainPublicationRecovery, settlePublicationResult } from './artifact-publication-recovery.js';
import type { ConnectorPersistence } from './persistence.js';
import { ConnectorTransportError } from './service-client.js';
import { unavailable, workCoordinates } from './work-policy-custody.js';

/** Runs only on the paired Connector. No publication bytes enter its event outbox or durable host route. */
export async function syncArtifactPublications(
  persistence: ConnectorPersistence,
  client: CollectiveArtifactOwnerClient,
  connectionId: string,
  owner: CollectiveArtifactOwnerPort,
) {
  if (!owner.publish) return;
  const current = () => {
    const connection = persistence.snapshot().connections[connectionId];
    if (!connection || connection.authorityStatus !== 'connected' || !connection.endpointCredential)
      throw unavailable();
    return { ...connection, endpointCredential: connection.endpointCredential };
  };
  const connection = current();
  const coordinates = workCoordinates(connection);
  const operations = await pollPublications(client, connection.serviceUrl, connection.endpointCredential, coordinates);
  for (const operation of operations) {
    const reauthorize = async () => {
      current();
      const fresh = await client.reauthorizePublication(
        connection.serviceUrl,
        connection.endpointCredential,
        coordinates,
        operation,
      );
      if (!isDeepStrictEqual(fresh, operation.publication)) throw unavailable();
      return fresh;
    };
    let result: CollectiveArtifactOwnerResult;
    try {
      await retainPublicationRecovery(persistence, connectionId, connection.endpointCredential, operation.publication);
      await reauthorize();
      result = await owner.publish(operation, { reauthorize });
      if (await settlePublicationResult(persistence, client, connectionId, owner, operation.publication, result))
        continue;
    } catch (error) {
      result = {
        status: 'error',
        error: {
          code:
            error instanceof ConnectorTransportError && error.statusCode === 403
              ? 'access_denied'
              : 'owner_unavailable',
        },
      };
    }
    await client
      .respondPublication(connection.serviceUrl, connection.endpointCredential, coordinates, operation.relayRef, result)
      .catch((error: unknown) => {
        if (!(error instanceof ConnectorTransportError) || error.retryable) throw error;
      });
  }
}

async function pollPublications(
  client: CollectiveArtifactOwnerClient,
  url: string,
  credential: string,
  coordinates: Parameters<CollectiveArtifactOwnerClient['pollPublications']>[2],
) {
  try {
    return await client.pollPublications(url, credential, coordinates);
  } catch (error) {
    // An old Service keeps its existing communication contract without this separate W4 protocol.
    if (error instanceof ConnectorTransportError && error.statusCode === 404 && error.code === 'NOT_FOUND') return [];
    throw error;
  }
}

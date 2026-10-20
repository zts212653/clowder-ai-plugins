import {
  type CollectiveArtifactPublication,
  type CollectiveArtifactPublicationRecovery,
  collectiveArtifactPublicationReceiptSchema,
} from '../contracts/index.js';
import type {
  CollectiveArtifactOwnerClient,
  CollectiveArtifactOwnerPort,
  CollectiveArtifactOwnerResult,
} from './artifact-owner-client.js';
import type { ConnectorPersistence } from './persistence.js';
import { workCoordinates } from './work-policy-custody.js';

/** Content-free intents precede owner execution. Its canonical receipt survives any lost relay/response/restart. */
export async function retainPublicationRecovery(
  persistence: ConnectorPersistence,
  connectionId: string,
  endpointCredential: string,
  publication: CollectiveArtifactPublication,
) {
  await persistence.transaction((state) => {
    const connection = state.connections[connectionId];
    if (!connection) throw new Error('Publication connection missing');
    connection.publicationRecoveries ??= {};
    connection.publicationRecoveries[publication.publicationId] = {
      publication: structuredClone(publication),
      endpointCredential,
    };
  });
}
export async function finishPublicationRecovery(
  persistence: ConnectorPersistence,
  client: CollectiveArtifactOwnerClient,
  connectionId: string,
  publicationId: string,
  outcome: CollectiveArtifactPublicationRecovery['outcome'],
) {
  const connection = persistence.snapshot().connections[connectionId];
  const recovery = connection?.publicationRecoveries?.[publicationId];
  if (!connection || !recovery) return;
  await client.recoverPublication(connection.serviceUrl, recovery.endpointCredential, {
    ...workCoordinates(connection),
    publicationId,
    outcome,
  });
  await persistence.transaction((state) => {
    const connection = state.connections[connectionId];
    if (!connection?.publicationRecoveries) return;
    delete connection.publicationRecoveries[publicationId];
    if (!Object.keys(connection.publicationRecoveries).length) delete connection.publicationRecoveries;
  });
}
export async function recoverPublications(
  persistence: ConnectorPersistence,
  client: CollectiveArtifactOwnerClient,
  connectionId: string,
  owner: CollectiveArtifactOwnerPort | undefined,
) {
  if (!owner?.recoverPublication) return;
  const recoveries = persistence.snapshot().connections[connectionId]?.publicationRecoveries;
  for (const recovery of Object.values(recoveries ?? {})) {
    const outcome = await owner.recoverPublication(recovery.publication);
    await finishPublicationRecovery(persistence, client, connectionId, recovery.publication.publicationId, outcome);
  }
}

export async function settlePublicationResult(
  persistence: ConnectorPersistence,
  client: CollectiveArtifactOwnerClient,
  connectionId: string,
  owner: CollectiveArtifactOwnerPort,
  publication: CollectiveArtifactPublication,
  result: CollectiveArtifactOwnerResult,
) {
  const outcome =
    result.status === 'ok'
      ? {
          status: 'committed' as const,
          receipt: collectiveArtifactPublicationReceiptSchema.parse(result.value.receipt),
        }
      : await owner.recoverPublication?.(publication);
  if (!outcome) return false;
  await finishPublicationRecovery(persistence, client, connectionId, publication.publicationId, outcome);
  return outcome.status === 'committed';
}

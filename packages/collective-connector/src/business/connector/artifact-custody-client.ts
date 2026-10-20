import {
  type CollectiveArtifactCustodyTransfer,
  type CollectiveCustodyPage,
  type CollectiveCustodyPageOperation,
  type CollectiveCustodyPrepared,
  type CollectiveCustodyReady,
  collectiveArtifactProjectionSchema,
  collectiveCustodyPageOperationSchema,
  collectiveCustodyPageSchema,
  collectiveCustodyTransferSchema,
} from '../contracts/index.js';
import { z } from 'zod';

type Coordinates = { serviceInstanceId: string; collectiveId: string; connectionId: string };
type Target = Coordinates & { artifactId: string; transferId: string };
type Transport = (
  url: string,
  path: string,
  options: { method: 'POST'; credential: string; body: unknown },
) => Promise<Record<string, unknown>>;
type Operation = 'prepareSource' | 'readPage' | 'stageTarget' | 'attestReady' | 'finalize';

/** Authenticated endpoint-only control and ephemeral page RPC. No Channel/event writer is used. */
export class CollectiveArtifactCustodyClient {
  constructor(private readonly request: Transport) {}
  private post(url: string, credential: string, path: string, body: unknown) {
    return this.request(url, `/api/artifacts/custody/${path}`, { method: 'POST', credential, body });
  }
  private async transfer(url: string, credential: string, path: string, input: unknown) {
    return z
      .object({ transfer: collectiveCustodyTransferSchema })
      .strict()
      .parse(await this.post(url, credential, path, input)).transfer;
  }
  async poll(url: string, credential: string, input: Coordinates) {
    return z
      .object({ transfers: z.array(collectiveCustodyTransferSchema).max(2) })
      .strict()
      .parse(await this.post(url, credential, 'poll', input)).transfers;
  }
  authorize(url: string, credential: string, input: Target, operation: Operation) {
    return this.transfer(url, credential, 'authorize', { ...input, operation });
  }
  prepared(url: string, credential: string, input: Target, proof: CollectiveCustodyPrepared) {
    return this.transfer(url, credential, 'prepared', { ...input, proof });
  }
  ready(url: string, credential: string, input: Target, proof: CollectiveCustodyReady) {
    return this.transfer(url, credential, 'ready', { ...input, proof });
  }
  async commit(url: string, credential: string, input: Target, transfer: CollectiveArtifactCustodyTransfer) {
    if (!transfer.prepared || !transfer.ready) throw new Error('Custody proofs missing');
    const result = await this.post(url, credential, 'accept', {
      serviceInstanceId: input.serviceInstanceId,
      collectiveId: input.collectiveId,
      connectionId: input.connectionId,
      artifactId: input.artifactId,
      handoffRef: transfer.transferId,
      expectedCustodyRevision: transfer.expectedCustodyRevision,
      ...transfer.prepared.version,
      ownerScopeRef: transfer.prepared.ownerScopeRef,
      preparedRef: transfer.prepared.preparedRef,
      readyRef: transfer.ready.readyRef,
      requestId: `${transfer.transferId}:commit`,
    });
    z.object({ artifact: collectiveArtifactProjectionSchema }).strict().parse(result);
    return this.transfer(url, credential, 'state', input);
  }
  finalized(url: string, credential: string, input: Target, outcome: 'committed' | 'cancelled') {
    return this.transfer(url, credential, 'finalized', { ...input, outcome });
  }
  async requestPage(url: string, credential: string, input: Target, index: number) {
    return z
      .object({ page: collectiveCustodyPageSchema })
      .strict()
      .parse(await this.post(url, credential, 'pages/request', { ...input, index })).page;
  }
  async pollPages(url: string, credential: string, input: Coordinates): Promise<CollectiveCustodyPageOperation[]> {
    return z
      .object({ operations: z.array(collectiveCustodyPageOperationSchema).max(2) })
      .strict()
      .parse(await this.post(url, credential, 'pages/poll', input)).operations;
  }
  async respondPage(
    url: string,
    credential: string,
    input: Coordinates,
    relayRef: string,
    result: { status: 'ok'; page: CollectiveCustodyPage } | { status: 'error'; error: 'owner_unavailable' },
  ) {
    z.object({ acknowledged: z.literal(true) })
      .strict()
      .parse(await this.post(url, credential, 'pages/respond', { ...input, relayRef, ...result }));
  }
}

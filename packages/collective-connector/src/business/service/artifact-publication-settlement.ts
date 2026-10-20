import { createHash } from 'node:crypto';
import { type CollectiveArtifactPublication, collectiveArtifactPublicationReceiptSchema } from '../contracts/index.js';
import { z } from 'zod';
import { denyArtifact } from './artifact-authority.js';
import { registerArtifactVersion } from './artifact-registration.js';
import type { MutableServiceState } from './state.js';

export function settleArtifactPublication(
  state: MutableServiceState,
  record: CollectiveArtifactPublication,
  value: Record<string, unknown>,
  now: number,
) {
  const { receipt } = z.object({ receipt: collectiveArtifactPublicationReceiptSchema }).strict().parse(value);
  const scope = {
    kind: 'collective-artifact',
    serviceInstanceId: record.serviceInstanceId,
    collectiveId: record.collectiveId,
    artifactId: record.artifactId,
    contentRef: record.contentRef,
    sourceEventId: record.sourceEventId,
    publishedByHumanId: record.humanId,
  };
  if (
    receipt.contentRef !== record.contentRef ||
    receipt.blobDigest !== record.blobDigest ||
    receipt.actor.actorId !== record.humanId ||
    receipt.operationId !== record.publicationId ||
    receipt.operationContext.actorHumanId !== record.humanId ||
    receipt.operationContext.dispositionId !== record.publicationId ||
    receipt.operationContext.requestDigest !== record.requestDigest ||
    receipt.operationContext.scopeRef !==
      `collective-owner:${createHash('sha256').update(JSON.stringify(scope)).digest('hex')}`
  )
    denyArtifact();
  if (record.status === 'published') {
    if (record.receiptRef !== receipt.receiptId) denyArtifact();
    return record;
  }
  if (state.artifacts[record.artifactId]) denyArtifact();
  state.artifacts[record.artifactId] = registerArtifactVersion(
    {
      serviceInstanceId: record.serviceInstanceId,
      collectiveId: record.collectiveId,
      connectionId: record.connectionId,
      contentRef: record.contentRef,
      title: record.title,
      mediaType: 'text/markdown',
      sourceEventId: record.sourceEventId,
      ...(record.workId ? { workId: record.workId } : {}),
      ownerRevision: receipt.ownerRevision,
      blobDigest: receipt.blobDigest,
      receiptRef: receipt.receiptId,
      requestId: record.requestId,
    },
    {
      humanId: record.humanId,
      endpointId: record.endpointId,
      sourceLocation: record.sourceLocation,
      at: new Date(now).toISOString(),
    },
    undefined,
  );
  const settled = { ...record, status: 'published' as const, receiptRef: receipt.receiptId, effectPending: false };
  state.artifactPublications[record.publicationId] = settled;
  return settled;
}

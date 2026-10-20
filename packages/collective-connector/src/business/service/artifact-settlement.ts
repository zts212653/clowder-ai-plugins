import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type CollectiveArtifactRelayOperation,
  collectiveArtifactAdoptionLineageSchema,
  collectiveArtifactProposalSelectionSchema,
} from '../contracts/index.js';
import { z } from 'zod';
import { denyArtifact, requireArtifact } from './artifact-authority.js';
import { CollectiveServiceError } from './errors.js';
import { provenEventLocation } from './event-location.js';
import type { MutableServiceState } from './state.js';

const id = z.string().min(1).max(256);
const positive = z.number().int().positive().safe();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const artifactSettlementSchema = z
  .object({
    state: z.literal('accepted'),
    lineage: collectiveArtifactAdoptionLineageSchema,
    receipt: z
      .object({
        receiptId: id,
        contentRef: id,
        previousOwnerRevision: positive,
        ownerRevision: positive,
        blobDigest: digest,
        operationId: id,
        outboxSequence: positive,
        actor: z.object({ kind: z.literal('human'), actorId: id }).strict(),
        operationContext: z
          .object({
            kind: z.literal('collective-artifact:apply'),
            scopeRef: id,
            dispositionId: id,
            requestDigest: digest,
            actorHumanId: id,
            custodyRevision: positive,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The owner response is trusted only from current custody, after fresh domain validation in the same transaction. */
export function recordArtifactSettlement(
  state: MutableServiceState,
  operation: CollectiveArtifactRelayOperation,
  unsafe: Record<string, unknown>,
  now: number,
  recovered = false,
) {
  const { receipt, lineage } = artifactSettlementSchema.parse(unsafe);
  const selection = recovered ? lineage : collectiveArtifactProposalSelectionSchema.parse(operation.payload);
  const c = operation.constraint;
  const artifact = requireArtifact(state, c.collectiveId, c.artifactId);
  const actorHumanId = recovered ? receipt.actor.actorId : c.humanId;
  const expectedOperation = recovered
    ? receipt.operationId
    : `collective-operation:${sha([c.serviceInstanceId, c.collectiveId, c.artifactId, c.humanId, c.action, operation.requestId])}`;
  const scopeRef = `collective-owner:${sha({
    kind: 'collective-artifact',
    serviceInstanceId: c.serviceInstanceId,
    collectiveId: c.collectiveId,
    artifactId: c.artifactId,
    contentRef: c.contentRef,
    sourceEventId: c.sourceEventId,
    publishedByHumanId: artifact.publishedByHumanId,
  })}`;
  const events = state.events[c.collectiveId] ?? [];
  const request = events.find((event) => event.eventId === lineage.requestEventId);
  const location = request && provenEventLocation(events, request);
  if (
    c.agent ||
    receipt.contentRef !== c.contentRef ||
    receipt.actor.actorId !== actorHumanId ||
    receipt.operationId !== expectedOperation ||
    !/^collective-operation:[a-f0-9]{64}$/.test(expectedOperation) ||
    receipt.ownerRevision !== receipt.previousOwnerRevision + 1 ||
    receipt.operationContext.actorHumanId !== actorHumanId ||
    receipt.operationContext.scopeRef !== scopeRef ||
    (recovered
      ? ![artifact.custody, ...artifact.custodyHistory].some(
          (item) => item.revision === receipt.operationContext.custodyRevision,
        )
      : receipt.operationContext.custodyRevision !== c.custodyRevision) ||
    receipt.operationContext.dispositionId !==
      `collective-adoption:${createHash('sha256').update(expectedOperation).digest('hex')}` ||
    receipt.operationContext.requestDigest !==
      `sha256:${sha([selection.requestId, selection.proposalRef, receipt.blobDigest, actorHumanId])}` ||
    lineage.requestId !== selection.requestId ||
    lineage.proposalRef !== selection.proposalRef ||
    lineage.sourceEventId !== artifact.sourceEventId ||
    lineage.sourceOwnerRevision !== receipt.previousOwnerRevision ||
    lineage.requestId !== `f309-modification-${sha(['collective-artifact', scopeRef, lineage.requestEventId])}` ||
    artifact.requestSources[lineage.requestEventId]?.ownerRevision !== receipt.previousOwnerRevision ||
    artifact.requestSources[lineage.requestEventId]?.blobDigest !==
      artifact.versions.find((version) => version.ownerRevision === receipt.previousOwnerRevision)?.blobDigest ||
    !request ||
    request.actor.kind !== 'human' ||
    request.recipient?.kind !== 'agent' ||
    !location ||
    lineage.location.channelId !== location.channelId ||
    lineage.location.rootEventId !== location.rootEventId ||
    location.channelId !== artifact.sourceLocation.channelId ||
    (location.rootEventId ?? request.eventId) !== (artifact.sourceLocation.rootEventId ?? artifact.sourceEventId)
  )
    denyArtifact();
  const prior = artifact.versions.find((version) => version.ownerRevision === receipt.ownerRevision);
  if (prior) {
    if (
      !isDeepStrictEqual(
        [prior.blobDigest, prior.receiptRef, prior.lineage, prior.adoptedByHumanId],
        [receipt.blobDigest, receipt.receiptId, lineage, receipt.actor.actorId],
      )
    )
      denyArtifact();
    return;
  }
  if (artifact.versions.at(-1)?.ownerRevision !== receipt.previousOwnerRevision)
    throw new CollectiveServiceError('ARTIFACT_REVISION_CONFLICT', 'Owner version lineage changed', 409);
  const at = new Date(now).toISOString();
  state.artifacts[artifact.artifactId] = {
    ...artifact,
    revision: artifact.revision + 1,
    updatedAt: at,
    versions: [
      ...artifact.versions,
      {
        ownerRevision: receipt.ownerRevision,
        blobDigest: receipt.blobDigest,
        receiptRef: receipt.receiptId,
        recordedAt: at,
        lineage,
        adoptedByHumanId: receipt.actor.actorId,
        authorCatId: request.recipient.agentId,
      },
    ],
  };
}

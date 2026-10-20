import { createHash } from 'node:crypto';
import {
  collectiveArtifactCatalogueHistoryRequestSchema,
  collectiveArtifactRequestReceiptQuerySchema,
} from '../contracts/index.js';
import {
  denyArtifact,
  projectArtifact,
  requireArtifact,
  requireArtifactAction,
  requireArtifactHuman,
} from './artifact-authority.js';
import { requireWorkSource } from './collaboration-command-helpers.js';
import { assertServiceCoordinates } from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import type { ServiceState } from './state.js';

/** Directory lineage belongs to the Service. Only explicit pages leave its canonical array. */
export function readArtifactHistory(state: ServiceState, session: string, unsafe: unknown) {
  const input = collectiveArtifactCatalogueHistoryRequestSchema.parse(unsafe);
  assertServiceCoordinates(state, input.serviceInstanceId, input.collectiveId);
  const human = requireArtifactHuman(state, session, input.collectiveId);
  const artifact = requireArtifact(state, input.collectiveId, input.artifactId);
  requireArtifactAction(state, artifact, human.humanId, 'history');
  if (artifact.sourceEventId !== input.sourceEventId) denyArtifact();
  const index =
    input.snapshotOwnerRevision === undefined
      ? artifact.versions.length - 1
      : artifact.versions.findIndex((version) => version.ownerRevision === input.snapshotOwnerRevision);
  const anchor = artifact.versions[index];
  if (!anchor) throw new CollectiveServiceError('ARTIFACT_REVISION_CONFLICT', 'History snapshot is unavailable', 409);
  const snapshot = `sha256:${createHash('sha256')
    .update(
      JSON.stringify([
        artifact.serviceInstanceId,
        artifact.collectiveId,
        artifact.artifactId,
        artifact.contentRef,
        artifact.sourceEventId,
        anchor.ownerRevision,
        anchor.receiptRef,
      ]),
    )
    .digest('hex')}`;
  if (input.expectedSnapshot && (input.snapshotOwnerRevision === undefined || input.expectedSnapshot !== snapshot))
    throw new CollectiveServiceError('ARTIFACT_REVISION_CONFLICT', 'History snapshot changed; read it again', 409);
  const total = index + 1;
  const end = index - input.offset;
  const versions = end < 0 ? [] : artifact.versions.slice(Math.max(0, end - input.limit + 1), end + 1).reverse();
  return {
    artifactId: artifact.artifactId,
    contentRef: artifact.contentRef,
    sourceEventId: artifact.sourceEventId,
    snapshotOwnerRevision: anchor.ownerRevision,
    snapshot,
    total,
    offset: input.offset,
    ...(input.offset + versions.length < total ? { nextOffset: input.offset + versions.length } : {}),
    versions,
  };
}

/** A public request has one exact Artifact binding. Looking up its accepted receipt never downloads its whole history. */
export function readArtifactRequestReceipt(state: ServiceState, session: string, unsafe: unknown) {
  const input = collectiveArtifactRequestReceiptQuerySchema.parse(unsafe);
  assertServiceCoordinates(state, input.serviceInstanceId, input.collectiveId);
  const human = requireArtifactHuman(state, session, input.collectiveId);
  const requested = new Set(input.requestEventIds);
  for (const eventId of requested) requireWorkSource(state, input.collectiveId, eventId);
  const seen = new Set<string>();
  const receipts = Object.values(state.artifacts).flatMap((artifact) => {
    if (artifact.collectiveId !== input.collectiveId) return [];
    const versions = artifact.versions.filter(
      (version) => version.lineage && requested.has(version.lineage.requestEventId),
    );
    if (!versions.length) return [];
    try {
      requireArtifactAction(state, artifact, human.humanId, 'history');
    } catch (error) {
      if (error instanceof CollectiveServiceError) return [];
      throw error;
    }
    return versions.map((version) => {
      const eventId = version.lineage?.requestEventId;
      if (!eventId || seen.has(eventId)) denyArtifact();
      seen.add(eventId);
      return { artifact: projectArtifact(state, artifact, human.humanId), version };
    });
  });
  return { receipts };
}

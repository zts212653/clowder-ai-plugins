import { createHash } from 'node:crypto';
import type { CollectiveArtifactRecord, CollectiveLocation, RegisterCollectiveArtifact } from '../contracts/index.js';
import { assertArtifactEffectAvailable } from './artifact-custody-authority.js';
import { CollectiveServiceError } from './errors.js';
/** Stable owner content identity, independent of its current custodian. */
export function artifactIdentity(serviceInstanceId: string, collectiveId: string, contentRef: string) {
  return `artifact_${createHash('sha256')
    .update(JSON.stringify([serviceInstanceId, collectiveId, contentRef]))
    .digest('hex')}`;
}
export function registerArtifactVersion(
  input: RegisterCollectiveArtifact,
  owner: { humanId: string; endpointId: string; sourceLocation: CollectiveLocation; at: string },
  previous: CollectiveArtifactRecord | undefined,
): CollectiveArtifactRecord {
  if (previous) {
    assertArtifactEffectAvailable(previous, true);
    if (
      previous.custody.connectionId !== input.connectionId ||
      previous.custody.revision !== input.expectedCustodyRevision ||
      previous.revision !== input.expectedRevision ||
      previous.sourceEventId !== input.sourceEventId ||
      previous.workId !== input.workId ||
      previous.mediaType !== input.mediaType ||
      input.ownerRevision <= (previous.versions.at(-1)?.ownerRevision ?? 0)
    ) {
      throw new CollectiveServiceError('ARTIFACT_REVISION_CONFLICT', 'The shared work version or custody changed', 409);
    }
  } else if (input.expectedRevision !== undefined || input.expectedCustodyRevision !== undefined) {
    throw new CollectiveServiceError('ARTIFACT_REVISION_CONFLICT', 'The shared work has not been published', 409);
  }
  const version = {
    ownerRevision: input.ownerRevision,
    ...(input.changeSummary ? { changeSummary: input.changeSummary } : {}),
    blobDigest: input.blobDigest,
    receiptRef: input.receiptRef,
    recordedAt: owner.at,
  };
  if (previous)
    return {
      ...previous,
      title: input.title,
      revision: previous.revision + 1,
      versions: [...previous.versions, version],
      updatedAt: owner.at,
    };
  return {
    serviceInstanceId: input.serviceInstanceId,
    collectiveId: input.collectiveId,
    artifactId: artifactIdentity(input.serviceInstanceId, input.collectiveId, input.contentRef),
    contentRef: input.contentRef,
    publishedByHumanId: owner.humanId,
    custody: { connectionId: input.connectionId, endpointId: owner.endpointId, revision: 1, status: 'active' },
    custodyHistory: [],
    custodyTransfers: {},
    access: { [owner.humanId]: { revision: 1, status: 'active', mayApply: true } },
    title: input.title,
    mediaType: input.mediaType,
    sourceEventId: input.sourceEventId,
    sourceLocation: owner.sourceLocation,
    ...(input.workId ? { workId: input.workId } : {}),
    revision: 1,
    versions: [version],
    requestSources: {},
    createdAt: owner.at,
    updatedAt: owner.at,
  };
}

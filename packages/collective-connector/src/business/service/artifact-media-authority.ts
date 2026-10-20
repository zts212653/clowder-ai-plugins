import { isDeepStrictEqual } from 'node:util';
import {
  type CollectiveArtifactMediaOperation,
  type CollectiveMediaDescriptor,
  parseMediaByteRange,
} from '../contracts/index.js';
import { denyArtifact, requireArtifact } from './artifact-authority.js';
import type { CollectiveArtifactConstraints } from './artifact-constraints.js';
import { requireAuthorizedHuman } from './connection-authority.js';
import type { ConnectionRecord, ServiceState } from './state.js';

export function assertMediaReader(
  state: ServiceState,
  expected: Pick<ConnectionRecord, 'connectionId' | 'endpointId' | 'authorizedHumanId' | 'credentialDigest'>,
) {
  const actual = state.connections[expected.connectionId];
  if (
    !actual ||
    actual.status !== 'connected' ||
    actual.endpointId !== expected.endpointId ||
    actual.credentialDigest !== expected.credentialDigest ||
    actual.authorizedHumanId !== expected.authorizedHumanId
  )
    denyArtifact();
  requireAuthorizedHuman(state, actual);
}
export function assertMediaOwner(
  constraints: CollectiveArtifactConstraints,
  credential: string,
  connectionId: string,
  operation: CollectiveArtifactMediaOperation,
) {
  const { serviceInstanceId, collectiveId, artifactId, sourceEventId, ownerRevision, decisionRef } =
    operation.constraint;
  const actual = constraints.validate(credential, {
    serviceInstanceId,
    collectiveId,
    connectionId,
    artifactId,
    sourceEventId,
    ownerRevision,
    decisionRef,
    action: 'read',
  });
  if (!isDeepStrictEqual(actual, operation.constraint)) denyArtifact();
}
export function assertMediaDescriptor(
  state: ServiceState,
  operation: CollectiveArtifactMediaOperation,
  descriptor: CollectiveMediaDescriptor,
) {
  const c = operation.constraint,
    artifact = requireArtifact(state, c.collectiveId, c.artifactId);
  const version = artifact.versions.find((version) => version.ownerRevision === c.ownerRevision);
  if (
    descriptor.contentRef !== c.contentRef ||
    descriptor.ownerRevision !== c.ownerRevision ||
    descriptor.blobDigest !== c.blobDigest ||
    descriptor.mediaType !== artifact.mediaType ||
    descriptor.ownerReceiptRef !== version?.receiptRef
  )
    denyArtifact();
  const range = operation.range === undefined ? undefined : parseMediaByteRange(operation.range, descriptor.byteLength);
  if (
    range === null
      ? descriptor.status !== 416
      : range
        ? descriptor.status !== 206 || descriptor.start !== range.start || descriptor.end !== range.end
        : descriptor.status !== 200
  )
    denyArtifact();
}

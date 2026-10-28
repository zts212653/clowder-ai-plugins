import { randomUUID } from 'node:crypto';
import type { CollectiveProjectArtifactItem, CollectiveProjectArtifactReference } from '../contracts/index.js';
import { CollectiveServiceError } from './errors.js';
import type { ServiceState } from './state.js';

export type ProjectArtifactOwnerRead = (session: string, input: unknown) => Promise<Record<string, unknown>>;
type Unavailable = Exclude<CollectiveProjectArtifactItem['availability'], 'available'>;
/** Metadata-only owner operation, admitted against the exact retained revision before any directory title is disclosed. */
export async function verifyProjectArtifactOwner(
  read: ProjectArtifactOwnerRead,
  state: ServiceState,
  session: string,
  reference: Pick<CollectiveProjectArtifactReference, 'collectiveId' | 'artifactId' | 'versionRef'>,
): Promise<Unavailable | undefined> {
  const artifact = state.artifacts[reference.artifactId];
  if (!artifact || artifact.collectiveId !== reference.collectiveId) return 'version_unavailable';
  try {
    const result = await read(session, {
      serviceInstanceId: state.serviceInstanceId,
      collectiveId: reference.collectiveId,
      artifactId: artifact.artifactId,
      sourceEventId: artifact.sourceEventId,
      ownerRevision: reference.versionRef.ownerRevision,
      action: 'history',
      requestId: randomUUID(),
      payload: { offset: 0, limit: 1 },
    });
    return result.contentRef === artifact.contentRef ? undefined : 'version_unavailable';
  } catch (error) {
    return error instanceof CollectiveServiceError && error.code === 'ARTIFACT_ACCESS_DENIED'
      ? 'access_denied'
      : error instanceof CollectiveServiceError && error.code === 'ARTIFACT_REVISION_CONFLICT'
        ? 'version_unavailable'
        : 'owner_unavailable';
  }
}

/** Bound the original relay's pending work; a page cannot exhaust every owner's admission slots. */
export async function mapProjectArtifactReads<T, R>(
  values: readonly T[],
  read: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(2, values.length) }, async () => {
      while (index < values.length) {
        const current = index++;
        result[current] = await read(values[current]!);
      }
    }),
  );
  return result;
}

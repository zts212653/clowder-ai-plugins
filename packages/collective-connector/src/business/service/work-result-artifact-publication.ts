import {
  promoteCollectiveWorkResultArtifactSchema,
  resolveCollectiveWorkResultArtifactSchema,
} from '../contracts/index.js';
import {
  denyArtifact,
  projectArtifact,
  requireArtifact,
  requireArtifactAction,
  requireArtifactHuman,
} from './artifact-authority.js';
import { prepareArtifactPublicationInState } from './artifact-publication-authority.js';
import { assertServiceCoordinates } from './connection-authority.js';
import type { PersistentServiceState } from './persistence.js';
import {
  assertPendingWorkResultPublicationCurrent,
  requireMarkdownWorkResultFile,
  requirePromotableWorkResultFile,
  workResultArtifactPublicationId,
  workResultArtifactRequestId,
} from './work-result-artifact-authority.js';

/** Prepare one content-free intent from canonical Work/file authority; the existing relay owns the byte effect. */
export async function prepareWorkResultArtifactPublication(
  persistence: PersistentServiceState,
  now: () => number,
  session: string,
  unsafe: unknown,
) {
  const input = promoteCollectiveWorkResultArtifactSchema.parse(unsafe);
  return persistence.transaction((state) => {
    const human = requireArtifactHuman(state, session, input.collectiveId);
    const { file, work } = requirePromotableWorkResultFile(state, {
      collectiveId: input.collectiveId,
      fileId: input.fileId,
      humanId: human.humanId,
    });
    const publication = prepareArtifactPublicationInState(state, now, session, {
      serviceInstanceId: input.serviceInstanceId,
      collectiveId: input.collectiveId,
      connectionId: file.connectionId,
      sourceEventId: work.sourceEventId,
      requestId: workResultArtifactRequestId(file.fileId),
      title: work.title,
      blobDigest: file.contentDigest,
      workId: file.workId,
    });
    return { publication, bytesBase64: file.contentBase64 };
  });
}

/** Resolve an already published result through the requesting member's current read policy. */
export function resolveWorkResultArtifactPublication(
  persistence: PersistentServiceState,
  session: string,
  unsafe: unknown,
) {
  const input = resolveCollectiveWorkResultArtifactSchema.parse(unsafe);
  const state = persistence.snapshot();
  assertServiceCoordinates(state, input.serviceInstanceId, input.collectiveId);
  const human = requireArtifactHuman(state, session, input.collectiveId);
  const file = requireMarkdownWorkResultFile(state, input);
  const publication = state.artifactPublications[workResultArtifactPublicationId(state, file)];
  const mayPromote = human.humanId === file.humanId;
  if (!publication) return { status: 'unpublished' as const, mayPromote };
  if (
    publication.requestId !== workResultArtifactRequestId(file.fileId) ||
    publication.serviceInstanceId !== state.serviceInstanceId ||
    publication.collectiveId !== file.collectiveId ||
    publication.connectionId !== file.connectionId ||
    publication.humanId !== file.humanId ||
    publication.workId !== file.workId ||
    publication.blobDigest !== file.contentDigest
  )
    denyArtifact();
  if (publication.status !== 'published') {
    assertPendingWorkResultPublicationCurrent(state, publication);
    return { status: 'pending' as const, mayPromote };
  }
  const artifact = requireArtifact(state, input.collectiveId, publication.artifactId);
  if (
    artifact.contentRef !== publication.contentRef ||
    artifact.publishedByHumanId !== file.humanId ||
    artifact.mediaType !== 'text/markdown' ||
    artifact.sourceEventId !== publication.sourceEventId ||
    artifact.workId !== file.workId ||
    artifact.versions[0]?.blobDigest !== file.contentDigest
  )
    denyArtifact();
  requireArtifactAction(state, artifact, human.humanId, 'read');
  return { status: 'published' as const, mayPromote: false, artifact: projectArtifact(state, artifact, human.humanId) };
}

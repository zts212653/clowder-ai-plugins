import { createHash } from 'node:crypto';
import { collectiveWorkResultFileIdSchema, type CollectiveArtifactPublication } from '../contracts/index.js';
import { CollectiveServiceError } from './errors.js';
import type { ServiceState, WorkResultFileRecord } from './state.js';

function denied(): never {
  throw new CollectiveServiceError('ARTIFACT_ACCESS_DENIED', 'Shared work access is no longer permitted', 403);
}

export const workResultArtifactRequestId = (fileId: string) => `work-result-artifact:${fileId}`;

export function workResultArtifactPublicationId(state: ServiceState, file: WorkResultFileRecord) {
  return `artifact-publication:${createHash('sha256')
    .update(JSON.stringify([state.serviceInstanceId, file.collectiveId, file.humanId, workResultArtifactRequestId(file.fileId)]))
    .digest('hex')}`;
}

export function requireMarkdownWorkResultFile(
  state: ServiceState,
  input: { readonly collectiveId: string; readonly fileId: string },
) {
  const file = state.workResultFiles[input.fileId];
  if (!file || file.collectiveId !== input.collectiveId)
    throw new CollectiveServiceError('WORK_RESULT_FILE_NOT_FOUND', 'Work result file was not found', 404);
  if (file.mediaType !== 'text/markdown')
    throw new CollectiveServiceError(
      'WORK_RESULT_ARTIFACT_UNSUPPORTED',
      'Only Markdown Work results can become shared works',
      409,
    );
  return file;
}

function requireCurrentResult(
  state: ServiceState,
  file: WorkResultFileRecord,
  humanId: string,
) {
  const work = state.works[file.workId];
  const assignment = work?.assignment;
  const event = state.events[file.collectiveId]?.find((candidate) => candidate.eventId === file.resultEventId);
  if (
    !work ||
    !assignment ||
    !event ||
    work.collectiveId !== file.collectiveId ||
    work.resultEventId !== file.resultEventId ||
    (work.resultRevision ?? 1) !== file.resultRevision ||
    !['result_ready', 'completed'].includes(work.lifecycle) ||
    work.accountableHumanId !== humanId ||
    assignment.humanId !== humanId ||
    assignment.connectionId !== file.connectionId ||
    assignment.catId !== file.catId ||
    work.assignmentEventId !== file.assignmentEventId ||
    event.workResultReceipt?.workId !== file.workId ||
    event.workResultReceipt.resultRevision !== file.resultRevision
  )
    denied();
  return work;
}

export function requirePromotableWorkResultFile(
  state: ServiceState,
  input: { readonly collectiveId: string; readonly fileId: string; readonly humanId: string },
) {
  const file = requireMarkdownWorkResultFile(state, input);
  if (file.humanId !== input.humanId) denied();
  return { file, work: requireCurrentResult(state, file, input.humanId) };
}

/** A pending derived publication stays bound to the exact current result until the owner effect is admitted. */
export function assertPendingWorkResultPublicationCurrent(
  state: ServiceState,
  publication: CollectiveArtifactPublication,
): void {
  if (publication.status === 'published' || publication.effectPending) return;
  const prefix = workResultArtifactRequestId('');
  if (!publication.requestId.startsWith(prefix)) return;
  const parsed = collectiveWorkResultFileIdSchema.safeParse(publication.requestId.slice(prefix.length));
  if (!parsed.success || !publication.workId) denied();
  const file = state.workResultFiles[parsed.data];
  if (
    !file ||
    file.mediaType !== 'text/markdown' ||
    file.collectiveId !== publication.collectiveId ||
    file.workId !== publication.workId ||
    file.connectionId !== publication.connectionId ||
    file.humanId !== publication.humanId ||
    file.contentDigest !== publication.blobDigest
  )
    denied();
  const work = requireCurrentResult(state, file, publication.humanId);
  if (work.sourceEventId !== publication.sourceEventId) denied();
}

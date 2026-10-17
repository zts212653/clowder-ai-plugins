import { isDeepStrictEqual } from 'node:util';
import type { AssignedWorkAuthorityScope, CollectiveConnector } from './business/connector/connector.js';
import type { CollectiveWorkResultPublication } from './business/connector/work-result-publication.js';
import { collectiveContextError } from './collective-context-refs.js';
import type { CollectiveWorkArtifactBinding, createCollectiveWorkArtifacts } from './collective-work-artifacts.js';

type Selection = {kind: 'none'} | {kind: 'unsealed'} |
  {kind: 'publication'; publication: CollectiveWorkResultPublication};
const unavailable = (code: string) => ({state: 'unavailable' as const, code,
  supportedContent: 'Package-published Task-scoped UTF8 Markdown/plain text, at most 65536 bytes'});

/** The original ca5 history witness: a prior Service result_returned event and
 * exactly one accepted local outbox snapshot for this same Work/Task/owner. */
function select(scope: AssignedWorkAuthorityScope, binding: CollectiveWorkArtifactBinding): Selection {
  const work = scope.work;
  const resultRevision = work.executionAuthority?.resultRevision ??
    (work.lifecycle === 'result_ready' ? (work.resultRevision ?? 1) : (work.resultEventId ? (work.resultRevision ?? 1) : 0) + 1);
  if (work.workId !== binding.work.workId || work.assignmentEventId !== binding.work.assignmentEventId ||
    work.assignment?.catId !== binding.auth.catId || work.assignment.connectionId !== binding.source.connectionId ||
    scope.connection.authorityStatus !== 'connected' || work.accountableHumanId !== scope.connection.authorizedHumanId ||
    scope.hostRoute?.localOwnerUserId !== binding.auth.userId ||
    (work.executionAuthority?.revision ?? 1) !== binding.work.executionRevision || resultRevision !== binding.work.resultRevision ||
    !['committed', 'in_progress', 'result_ready'].includes(work.lifecycle))
    throw collectiveContextError('WORK_EXECUTION_NOT_CURRENT', 'Current Work changed during historical artifact read');
  const prior = work.history.filter(entry => entry.action === 'result_returned' &&
    (entry.resultRevision ?? 1) < binding.work.resultRevision).at(-1);
  if (!prior?.eventId) return {kind: 'none'};
  const candidates = scope.resultPublications.filter(publication =>
    publication.resultEventId === prior.eventId && publication.resultRevision === (prior.resultRevision ?? 1) &&
    publication.assignmentEventId === binding.work.assignmentEventId && publication.workId === work.workId &&
    publication.taskRef === binding.auth.task.taskRef && publication.localOwnerUserId === binding.auth.userId &&
    publication.authorizedHumanId === scope.connection.authorizedHumanId);
  return candidates.length === 1 ? {kind: 'publication', publication: candidates[0]!} : {kind: 'unsealed'};
}

export async function readPreviousCollectiveWorkArtifact(connector: CollectiveConnector,
  binding: CollectiveWorkArtifactBinding, artifacts: ReturnType<typeof createCollectiveWorkArtifacts>) {
  const readWitness = () => connector.withSynchronizedAssignedWorkAuthority(binding.source.connectionId,
    binding.work.assignmentEventId, async scope => select(scope, binding));
  // current reenters the connection fence; never invoke it while readWitness
  // holds that fence. Storage/message reads likewise occur after it releases.
  await binding.revalidate(); const before = await readWitness(); await binding.revalidate();
  if (before.kind === 'none') return undefined;
  if (before.kind === 'unsealed') return unavailable('UNSEALED_RESULT');
  const snapshot = before.publication.artifactSnapshot;
  if (!snapshot || !snapshot.textPublication) return unavailable('UNSEALED_ARTIFACT');
  if (!/^collective-artifact:[a-f0-9]{64}$/.test(snapshot.artifactRef)) return unavailable('LEGACY_ARTIFACT_UNAVAILABLE');
  return artifacts.readAccepted(binding, before.publication, async () => {
    await binding.revalidate(); const after = await readWitness(); await binding.revalidate();
    if (!isDeepStrictEqual(before, after))
      throw collectiveContextError('WORK_ARTIFACT_UNAVAILABLE', 'Accepted result witness changed during artifact read');
  });
}

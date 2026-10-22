import { isDeepStrictEqual } from 'node:util';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';
import { z } from 'zod';
import type { CollectiveConnector, AssignedWorkAuthorityScope } from './business/connector/connector.js';
import type { CollectiveWorkResultPublication } from './business/connector/work-result-publication.js';
import type { createCollectiveMessageWorkArtifacts } from './collective-message-work-artifacts.js';

const COVERAGE = 'current_f290_collective_work_results' as const;
const bounded = z.string().trim().min(1).max(1_000);
const receiptSchema = z
  .object({
    eligible: z.literal(true),
    producer: z
      .object({
        producerId: z.literal('f290.collective_work_result'),
        ownerRef: bounded,
        subjectRef: bounded,
        revision: z.number().int().positive(),
      })
      .strict(),
    taskRef: z.object({ subjectRef: bounded, observedRevision: z.number().int().positive() }).strict(),
    kind: z.literal('judgment'),
    reasonCode: z.literal('collective_result_ready'),
    recommendation: z.literal('Review the prepared result in its Collective Work'),
    salience: z.literal('normal'),
    action: z.object({ actionRef: bounded, expectedProducerRevision: z.number().int().positive() }).strict(),
    reEvaluateActionRef: bounded,
  })
  .strict();

export type CollectiveWorkResultAttentionReceipt = z.infer<typeof receiptSchema>;
export interface CollectiveWorkResultAttentionSourceRead {
  readonly items: CollectiveWorkResultAttentionReceipt[];
  readonly reasons: string[];
  readonly state: {
    readonly coverage: typeof COVERAGE;
    readonly startedAt: number;
    readonly observedAt: number;
    readonly status: 'available' | 'unavailable';
    readonly exhaustiveness: 'complete' | 'partial' | 'unknown';
  };
}

/** Installed Work feature owns discovery and F290 authority; Host receives only generic attention receipts. */
export async function readCollectiveWorkResultAttentionSource(
  connector: CollectiveConnector | undefined,
  context: Pick<FeatureContext, 'pluginInstanceId' | 'messaging' | 'storage' | 'tasks' | 'threads'>,
  artifacts: ReturnType<typeof createCollectiveMessageWorkArtifacts>,
  ownerUserId: string,
  assertCurrent: () => Promise<void> = async () => {},
): Promise<CollectiveWorkResultAttentionSourceRead> {
  await assertCurrent();
  const startedAt = Date.now();
  if (!connector)
    return {
      items: [],
      reasons: ['collective_result_connector_unavailable'],
      state: { coverage: COVERAGE, startedAt, observedAt: Date.now(), status: 'unavailable', exhaustiveness: 'unknown' },
    };
  let candidates: Awaited<ReturnType<CollectiveConnector['listWorkResultPublicationCandidates']>>;
  try {
    candidates = await connector.listWorkResultPublicationCandidates();
    await assertCurrent();
  } catch {
    return {
      items: [],
      reasons: ['collective_result_candidate_read_failed'],
      state: { coverage: COVERAGE, startedAt, observedAt: Date.now(), status: 'unavailable', exhaustiveness: 'unknown' },
    };
  }
  const items: CollectiveWorkResultAttentionReceipt[] = [];
  const reasons = new Set<string>();
  for (const candidate of candidates.sort(
    (left, right) => left.connectionId.localeCompare(right.connectionId) || left.workId.localeCompare(right.workId),
  )) {
    try {
      const item = await connector.withAssignedWorkAuthority(candidate.connectionId, candidate.workId, async (scope) =>
        projectCandidate(context, artifacts, ownerUserId, scope, assertCurrent),
      );
      if (item) items.push(item);
    } catch {
      reasons.add('collective_result_candidate_changed');
    }
  }
  await assertCurrent();
  const deduplicated = new Map<string, CollectiveWorkResultAttentionReceipt>();
  for (const item of items) {
    const previous = deduplicated.get(item.producer.subjectRef);
    if (previous && !isDeepStrictEqual(previous, item)) {
      deduplicated.delete(item.producer.subjectRef);
      reasons.add('collective_result_identity_conflict');
    } else if (!previous) deduplicated.set(item.producer.subjectRef, item);
  }
  return {
    items: [...deduplicated.values()].sort((left, right) =>
      left.producer.subjectRef.localeCompare(right.producer.subjectRef),
    ),
    reasons: [...reasons],
    state: {
      coverage: COVERAGE,
      startedAt,
      observedAt: Date.now(),
      status: 'available',
      exhaustiveness: reasons.size ? 'partial' : 'complete',
    },
  };
}

async function projectCandidate(
  context: Pick<FeatureContext, 'pluginInstanceId' | 'messaging' | 'storage' | 'tasks' | 'threads'>,
  artifacts: ReturnType<typeof createCollectiveMessageWorkArtifacts>,
  ownerUserId: string,
  scope: AssignedWorkAuthorityScope,
  assertCurrent: () => Promise<void>,
) {
  const work = scope.work;
  if (work.lifecycle !== 'result_ready' || work.status !== 'result_ready' || !work.resultEventId) return null;
  const publications = scope.resultPublications.filter((publication) => currentPublication(scope, publication));
  if (publications.length !== 1) return null;
  const publication = publications[0];
  if (!publication || publication.localOwnerUserId !== ownerUserId) return null;
  const taskId = /^task:work:(.+)$/u.exec(publication.taskRef)?.[1];
  if (!taskId) return null;
  const task = await context.tasks.get({ id: taskId });
  await assertCurrent();
  const entrusted = task?.entrustedWork;
  const snapshot = publication.artifactSnapshot;
  if (
    !task ||
    task.userId !== ownerUserId ||
    task.ownerCatId !== publication.catId ||
    task.status === 'done' ||
    !entrusted ||
    entrusted.closure.state !== 'open' ||
    entrusted.revision !== publication.taskRevision ||
    entrusted.artifactRefs?.length !== 1 ||
    !snapshot ||
    snapshot.taskRef !== publication.taskRef ||
    snapshot.taskRevision !== publication.taskRevision ||
    entrusted.artifactRefs?.[0] !== snapshot.artifactRef
  )
    return null;
  const sealed = await artifacts.sealAccepted(scope, publication, assertCurrent);
  if (!sealed) return null;
  const { taskRef: _taskRef, taskRevision: _taskRevision, textPublication: _seal, ...prepared } =
    sealed.artifactSnapshot;
  const { taskRef: _originalTask, taskRevision: _originalRevision, textPublication: _originalSeal, ...original } =
    snapshot;
  if (!isDeepStrictEqual(prepared, original)) return null;
  const subjectRef = `collective-result:${publication.connectionId}:${publication.workId}`;
  const query = new URLSearchParams([
    ['connectionId', publication.connectionId],
    ['workId', publication.workId],
    ['workRevision', String(work.revision)],
    ['channelId', publication.channelId],
    ['resultEventId', publication.resultEventId],
    ['resultRevision', String(publication.resultRevision)],
  ]);
  return receiptSchema.parse({
    eligible: true,
    producer: {
      producerId: 'f290.collective_work_result',
      ownerRef: subjectRef,
      subjectRef,
      revision: work.revision,
    },
    taskRef: { subjectRef: publication.taskRef, observedRevision: publication.taskRevision },
    kind: 'judgment',
    reasonCode: 'collective_result_ready',
    recommendation: 'Review the prepared result in its Collective Work',
    salience: 'normal',
    action: { actionRef: `/collective?${query}`, expectedProducerRevision: work.revision },
    reEvaluateActionRef: `${subjectRef}#reevaluate`,
  });
}

function currentPublication(scope: AssignedWorkAuthorityScope, publication: CollectiveWorkResultPublication) {
  const work = scope.work;
  const assignment = work.assignment;
  return Boolean(
    assignment &&
      scope.connection.authorityStatus === 'connected' &&
      scope.connection.authorizedHumanId === publication.authorizedHumanId &&
      publication.serviceInstanceId === scope.connection.serviceInstanceId &&
      publication.collectiveId === scope.connection.collectiveId &&
      publication.connectionId === scope.connection.connectionId &&
      publication.workId === work.workId &&
      publication.resultEventId === work.resultEventId &&
      publication.resultRevision === (work.resultRevision ?? 1) &&
      publication.assignmentEventId === work.assignmentEventId &&
      publication.authorizedHumanId === work.accountableHumanId &&
      publication.connectionId === assignment.connectionId &&
      publication.authorizedHumanId === assignment.humanId &&
      publication.catId === assignment.catId,
  );
}

import type {
  CollectiveMaterialSourceResult,
  SortCollectiveMaterialRequest,
} from '../contracts/types/collective-material.js';
import { humanActor, mutableWork, requireHumanCommand, requireRoadmap } from './collaboration-command-helpers.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import { createCollectiveProjectTask } from './collaboration-project-authoring.js';
import { CollectiveServiceError } from './errors.js';
import { requireMaterial } from './project-material-authority.js';
import type { MutableServiceState } from './state.js';

export function sortProjectMaterial(
  state: MutableServiceState,
  sessionToken: string,
  input: SortCollectiveMaterialRequest,
  source: Extract<CollectiveMaterialSourceResult, { status: 'available' }>,
  publicationId: string,
  now: number,
) {
  const human = requireHumanCommand(state, sessionToken, input);
  const material = requireMaterial(state, input.collectiveId, input.materialId);
  const project = requireRoadmap(state, input.collectiveId, material.roadmapId);
  if (project.accountableHumanId !== human.humanId)
    throw new CollectiveServiceError('ROADMAP_AUTHORITY_REQUIRED', 'Only the Project owner can sort its material', 403);
  const actorScope = `human:${human.humanId}`;
  const replay = collaborationOperationReplay(state, {
    ...input,
    actorScope,
    payload: input,
    resourceKind: 'material',
  });
  const clauseId = 'clauseId' in input ? input.clauseId : undefined;
  const previous = material.disposition ?? (clauseId ? material.decisions[clauseId] : undefined);
  if (previous)
    return {
      outcome: 'already_processed' as const,
      materialId: material.materialId,
      revision: material.revision,
      decision: structuredClone(previous),
    };
  if (
    replay.existing ||
    material.revision !== input.expectedRevision ||
    material.currentWitness.digest !== source.witness.digest
  )
    throw new CollectiveServiceError(
      'MATERIAL_REVISION_CONFLICT',
      'The material changed; refresh before deciding',
      409,
    );
  if (clauseId && !source.material.clauses.some((clause) => clause.clauseId === clauseId))
    throw new CollectiveServiceError(
      'MATERIAL_REVISION_CONFLICT',
      'This source passage changed; read the current material',
      409,
    );
  if (project.status !== 'active')
    throw new CollectiveServiceError('ROADMAP_COMPLETED', 'Reopen this Project before sorting material', 409);
  const at = new Date(now).toISOString(),
    actor = humanActor(human);
  let workId: string | undefined;
  if (input.action === 'create') {
    const created = createCollectiveProjectTask(
      state,
      {
        serviceInstanceId: input.serviceInstanceId,
        collectiveId: input.collectiveId,
        title: input.title,
        intendedOutcome: input.intendedOutcome,
        expectedRoadmapRevision: input.expectedRoadmapRevision,
        requestId: `${input.requestId}:create`,
        roadmapId: project.roadmapId,
        channelId: project.sourceLocation.channelId,
        accountability: 'unassigned',
      },
      human,
      now,
    );
    workId = created.work.workId;
  } else if (input.action === 'merge') {
    const work = mutableWork(state, input.collectiveId, input.workId);
    if (!project.workIds.includes(work.workId))
      throw new CollectiveServiceError('WORK_NOT_IN_ROADMAP', 'Choose a Task in this Project', 409);
    if (work.revision !== input.expectedWorkRevision)
      throw new CollectiveServiceError('WORK_REVISION_CONFLICT', 'The Task changed; refresh before linking it', 409);
    workId = work.workId;
  }
  const publication = material.publicationIds.includes(publicationId)
    ? state.materialPublications[publicationId]
    : undefined;
  if (!publication || publication.state !== 'published' || publication.sourceKey !== source.sourceKey)
    throw new CollectiveServiceError('MATERIAL_SOURCE_UNAVAILABLE', 'Published source is unavailable', 409);
  if (workId) {
    const work = mutableWork(state, input.collectiveId, workId);
    work.materialLinks ??= [];
    work.materialLinks.push({
      materialId: material.materialId,
      publicationId: publication.publicationId,
      ...(clauseId ? { clauseId } : {}),
      sourceRef: source.sourceRef,
      witness: source.witness,
      actor,
      at,
    });
    work.revision += 1;
    work.updatedAt = at;
    work.history.push({
      revision: work.revision,
      action: 'material_linked',
      actor,
      at,
      eventId: publication.sourceEventId,
    });
  }
  const current = state.materials[material.materialId]!;
  const decision = {
    action: input.action,
    actor,
    at,
    requestId: input.requestId,
    ...(workId ? { workId } : {}),
    witness: source.witness,
  };
  if (clauseId) current.decisions[clauseId] = decision;
  else current.disposition = decision;
  current.revision += 1;
  current.updatedAt = at;
  recordCollaborationOperation(state, {
    ...replay,
    actorScope,
    resourceKind: 'material',
    resourceId: current.materialId,
    revision: current.revision,
    recordedAt: at,
  });
  return { outcome: 'processed' as const, materialId: current.materialId, revision: current.revision, decision };
}

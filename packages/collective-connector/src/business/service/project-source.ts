import { sameCollectiveMaterialWitness } from '../contracts/types/collective-material.js';
import {
  collectiveMaterialSuggestionRequestSchema,
  collectiveProjectSourceReadSchema,
  collectiveProjectSourceRequestSchema,
} from '../contracts/types/collective-project-source.js';
import { requireRoadmap } from './collaboration-command-helpers.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import { requireAuthorizedHuman, requireConnection } from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import {
  canReadLinkedParticipationSource,
  requireParticipant,
  requireParticipationSource,
} from './participation-store.js';
import type { PersistentServiceState } from './persistence.js';
import { requireMaterial } from './project-material-authority.js';
import type { CollectiveProjectMaterialStore } from './project-material-store.js';
import type { ServiceState } from './state.js';
import { observedWorkTime } from './work-observed-time.js';
import { projectParticipantArtifactReferences } from './project-artifact-participant.js';

/** Public publication receipts are the only discoverable source; private provider inboxes are never listed. */
export async function readProjectSource(
  persistence: PersistentServiceState,
  materials: CollectiveProjectMaterialStore,
  credential: string,
  unsafe: unknown,
  includeArtifactReferences = false,
) {
  const input = collectiveProjectSourceRequestSchema.parse(unsafe);
  const check = (state: ServiceState) =>
    requireParticipationSource(state, credential, { ...input, eventId: input.sourceEventId });
  const state = persistence.snapshot(),
    source = check(state);
  const projects = Object.values(state.roadmaps).filter(
    (project) =>
      project.collectiveId === input.collectiveId &&
      project.sourceLocation.channelId === source.location.channelId &&
      canReadLinkedParticipationSource(state, credential, input, project.sourceEventId),
  );
  const dates = Object.values(state.works).filter(
    (work) =>
      work.collectiveId === input.collectiveId &&
      work.sourceLocation.channelId === source.location.channelId &&
      work.lifecycle !== 'proposed' &&
      canReadLinkedParticipationSource(state, credential, input, work.sourceEventId),
  );
  const found = [];
  for (const project of projects.slice(0, 12)) {
    const list = await materials.listForParticipant({ ...input, roadmapId: project.roadmapId }, check, input.materialId);
    for (const item of list.items) {
      if (input.materialId && item.materialId !== input.materialId) continue;
      found.push({
        materialId: item.materialId,
        roadmapId: item.roadmapId,
        revision: item.revision,
        title: item.material.title,
        sourceRef: item.publication.sourceRef!,
        witness: item.currentWitness,
        clauseIds: item.material.clauses.map((clause) => clause.clauseId),
        ...(input.materialId ? { material: item.material } : {}),
      });
    }
  }
  const finalState = persistence.snapshot();
  check(finalState);
  return collectiveProjectSourceReadSchema.parse({
    sourceEventId: input.sourceEventId,
    projects: projects
      .slice(0, 12)
      .map((project) => ({ roadmapId: project.roadmapId, title: project.title, revision: project.revision,
        ...(includeArtifactReferences ? projectParticipantArtifactReferences(finalState, credential, input, project.roadmapId) : {}) })),
    dates: dates.slice(0, 100).map((work) => ({
      workId: work.workId,
      title: work.title,
      revision: work.revision,
      time: observedWorkTime(work),
    })),
    materials: found.slice(0, 100),
    hasMore: projects.length > 12 || dates.length > 100 || found.length > 100,
    trust: 'untrusted_external',
    instructionPolicy: 'data_only',
  });
}

/** A Cat selects source clauses; only the Human can turn those suggestions into Work or dates. */
export async function suggestMaterial(
  persistence: PersistentServiceState,
  materials: CollectiveProjectMaterialStore,
  credential: string,
  unsafe: unknown,
  now: number,
) {
  const input = collectiveMaterialSuggestionRequestSchema.parse(unsafe);
  const read = await readProjectSource(persistence, materials, credential, inputForRead(input));
  const current = read.materials.find((item) => item.materialId === input.materialId);
  if (!current?.material)
    throw new CollectiveServiceError('MATERIAL_SOURCE_UNAVAILABLE', 'Original source is unavailable', 409);
  return persistence.transaction((state) => {
    const source = requireParticipationSource(state, credential, { ...input, eventId: input.sourceEventId });
    const connection = requireConnection(state, credential, input.connectionId),
      human = requireAuthorizedHuman(state, connection);
    const participant = requireParticipant(state, {
      ...input,
      humanId: human.humanId,
      channelId: source.location.channelId,
    });
    const record = requireMaterial(state, input.collectiveId, input.materialId);
    const actorScope = `connection:${input.connectionId}:cat:${input.catId}`;
    const replay = collaborationOperationReplay(state, {
      ...input,
      actorScope,
      payload: input,
      resourceKind: 'material',
    });
    if (replay.existing) return structuredClone(record);
    if (
      record.revision !== input.expectedRevision ||
      !sameCollectiveMaterialWitness(record.currentWitness, current.witness)
    )
      throw new CollectiveServiceError('MATERIAL_REVISION_CONFLICT', 'Material changed; read its current source', 409);
    const project = requireRoadmap(state, input.collectiveId, record.roadmapId);
    if (
      (input.suggestedWorkId && !project.workIds.includes(input.suggestedWorkId)) ||
      input.clauseIds.some((id) => !current.clauseIds.includes(id))
    )
      throw new CollectiveServiceError(
        'MATERIAL_SOURCE_UNAVAILABLE',
        'Selected clause or task is outside this source',
        409,
      );
    const at = new Date(now).toISOString();
    const actor = {
      kind: 'agent' as const,
      humanId: human.humanId,
      humanDisplayName: human.displayName,
      connectionId: input.connectionId,
      catId: participant.catId,
      displayName: participant.displayName,
    };
    const selections = (record.selections ??= []);
    for (const clauseId of new Set(input.clauseIds)) {
      const previous = selections.findIndex(
        (selection) =>
          selection.clauseId === clauseId &&
          selection.actor.kind === 'agent' &&
          selection.actor.connectionId === input.connectionId &&
          selection.actor.catId === input.catId,
      );
      const selection = {
        clauseId,
        witness: current.witness,
        actor,
        at,
        ...(input.suggestedWorkId ? { suggestedWorkId: input.suggestedWorkId } : {}),
      };
      if (previous >= 0) selections[previous] = selection;
      else selections.push(selection);
    }
    record.revision += 1;
    record.updatedAt = at;
    recordCollaborationOperation(state, {
      ...replay,
      actorScope,
      resourceKind: 'material',
      resourceId: record.materialId,
      revision: record.revision,
      recordedAt: at,
    });
    return structuredClone(record);
  });
}
function inputForRead(
  input: import('../contracts/types/collective-project-source.js').CollectiveMaterialSuggestionRequest,
) {
  const { requestId: _, clauseIds: _clauses, expectedRevision: _rev, suggestedWorkId: _work, ...read } = input;
  return read;
}

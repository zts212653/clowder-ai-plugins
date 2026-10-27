import type {
  ChangeCollectiveAgentWorkTimeRequest,
  ChangeCollectiveWorkTimeRequest,
  CollectiveCollaborationActor,
  CollectiveTimeFact,
  CollectiveTimeInput,
  SetCollectiveRoadmapTargetDateRequest,
} from '../contracts/index.js';
import { requireRoadmap, requireWorkSource } from './collaboration-command-helpers.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import {
  projectCollectiveWork,
  requireCollectiveWork,
  requireWorkAccountableHuman,
  requireWorkRevision,
} from './collaboration-work.js';
import { CollectiveServiceError } from './errors.js';
import { createStableId } from './persistence.js';
import type { MutableServiceState } from './state.js';
import { observedWorkTime } from './work-observed-time.js';

type TimeCommand = ChangeCollectiveWorkTimeRequest | ChangeCollectiveAgentWorkTimeRequest;
type Work = MutableServiceState['works'][string];
type TimeChange = NonNullable<Work['history'][number]['timeChange']>;

export function changeCollectiveWorkTime(
  state: MutableServiceState,
  input: TimeCommand,
  actor: CollectiveCollaborationActor,
  now: number,
) {
  const actorScope =
    actor.kind === 'human' ? `human:${actor.humanId}` : `connection:${actor.connectionId}:cat:${actor.catId}`;
  const replay = collaborationOperationReplay(state, { ...input, actorScope, payload: input, resourceKind: 'work' });
  const work = requireCollectiveWork(state, input.collectiveId, input.workId) as Work;
  if (replay.existing) return projectCollectiveWork(state, work, now);
  requireWorkRevision(work, input.expectedRevision);
  if (work.lifecycle === 'proposed')
    throw new CollectiveServiceError('WORK_NOT_COMMITTED', 'Accept this task before setting its dates', 409);
  const at = new Date(now).toISOString();
  const sourceEventId = 'sourceEventId' in input ? input.sourceEventId : undefined;
  const sourceLocation = sourceEventId
    ? requireWorkSource(state, input.collectiveId, sourceEventId).location
    : work.sourceLocation;
  const sourceRef = sourceEventId
    ? `event:${sourceEventId}`
    : `collective-work:${state.serviceInstanceId}:${input.collectiveId}:${work.workId}#time-r${work.revision + 1}`;
  let change: TimeChange | undefined;
  let action: Work['history'][number]['action'];
  if (input.action === 'suggest') {
    (work.timeSuggestions ??= []).push({
      suggestionId: createStableId('time_'),
      field: input.field,
      time: input.time,
      reason: input.reason,
      actor,
      at,
      sourceRef,
      sourceLocation,
      ...(sourceEventId ? { sourceEventId } : {}),
      status: 'pending',
    });
    action = 'time_suggested';
  } else if (input.action === 'respond') {
    requireTimeOwner(work, actor);
    const suggestion = work.timeSuggestions?.find((item) => item.suggestionId === input.suggestionId);
    if (!suggestion || suggestion.status !== 'pending')
      throw new CollectiveServiceError(
        'TIME_SUGGESTION_RESOLVED',
        'This date suggestion has already been handled',
        409,
      );
    if (input.decision === 'accept') {
      const current = suggestion.time
        ? timeFact(
            suggestion.time,
            actor,
            at,
            suggestion.sourceRef,
            suggestion.sourceEventId,
            suggestion.sourceLocation,
          )
        : null;
      if (current) current.suggestedBy = suggestion.actor;
      change = applyTime(work, suggestion.field, current);
      change.suggestionId = suggestion.suggestionId;
    }
    suggestion.status = input.decision === 'accept' ? 'accepted' : 'kept';
    suggestion.resolvedAt = at;
    suggestion.resolvedBy = actor;
    action = 'time_suggestion_resolved';
  } else {
    const isExecutor = work.assignment
      ? actor.humanId === work.assignment.humanId &&
        (actor.kind === 'human' ||
          (actor.connectionId === work.assignment.connectionId && actor.catId === work.assignment.catId))
      : actor.kind === 'human' && actor.humanId === work.accountableHumanId;
    if (input.field === 'businessDeadline' || input.field === 'reviewBy') requireTimeOwner(work, actor);
    else if (
      !isExecutor &&
      !(input.field === 'plannedStart' && actor.kind === 'human' && actor.humanId === work.accountableHumanId)
    )
      throw new CollectiveServiceError(
        'WORK_EXECUTOR_REQUIRED',
        'Only this task’s executor can give its estimate',
        403,
      );
    change = applyTime(
      work,
      input.field,
      input.time ? timeFact(input.time, actor, at, sourceRef, sourceEventId, sourceLocation) : null,
    );
    action = 'time_changed';
  }
  work.revision += 1;
  work.updatedAt = at;
  work.history.push({
    revision: work.revision,
    action,
    actor,
    at,
    ...(sourceEventId ? { eventId: sourceEventId } : {}),
    ...(change ? { timeChange: change } : {}),
  });
  recordCollaborationOperation(state, {
    ...replay,
    actorScope,
    resourceKind: 'work',
    resourceId: work.workId,
    revision: work.revision,
    recordedAt: at,
  });
  return projectCollectiveWork(state, work, now);
}

function requireTimeOwner(work: Work, actor: CollectiveCollaborationActor) {
  if (actor.kind !== 'human')
    throw new CollectiveServiceError(
      'WORK_AUTHORITY_REQUIRED',
      'Only the accountable Human confirms task promises',
      403,
    );
  requireWorkAccountableHuman(work, actor.humanId);
}

function timeFact(
  time: CollectiveTimeInput,
  actor: CollectiveCollaborationActor,
  at: string,
  sourceRef: string,
  sourceEventId?: string,
  sourceLocation?: CollectiveTimeFact['sourceLocation'],
): CollectiveTimeFact {
  return {
    ...time,
    actor,
    at,
    sourceRef,
    ...(sourceLocation ? { sourceLocation } : {}),
    ...(sourceEventId ? { sourceEventId } : {}),
  };
}

function applyTime(work: Work, field: TimeChange['field'], current: CollectiveTimeFact | null): TimeChange {
  const dates = (work.time ??= {});
  const previous = dates[field] ?? null;
  if (current) dates[field] = current;
  else delete dates[field];
  return { field, previous, current };
}

export function setCollectiveRoadmapTargetDate(
  state: MutableServiceState,
  input: SetCollectiveRoadmapTargetDateRequest,
  actor: CollectiveCollaborationActor,
  now: number,
) {
  const roadmap = requireRoadmap(state, input.collectiveId, input.roadmapId) as MutableServiceState['roadmaps'][string];
  if (actor.kind !== 'human' || roadmap.accountableHumanId !== actor.humanId)
    throw new CollectiveServiceError('ROADMAP_AUTHORITY_REQUIRED', 'Only the project owner can set its target', 403);
  const actorScope = `human:${actor.humanId}`;
  const replay = collaborationOperationReplay(state, { ...input, actorScope, payload: input, resourceKind: 'roadmap' });
  if (replay.existing) return structuredClone(roadmap);
  if (roadmap.revision !== input.expectedRevision)
    throw new CollectiveServiceError('ROADMAP_REVISION_CONFLICT', 'This project changed; refresh and try again', 409);
  const sourceLocation = input.sourceEventId
    ? requireWorkSource(state, input.collectiveId, input.sourceEventId).location
    : roadmap.sourceLocation;
  const at = new Date(now).toISOString();
  const sourceRef = input.sourceEventId
    ? `event:${input.sourceEventId}`
    : `collective-project:${roadmap.roadmapId}#target-r${roadmap.revision + 1}`;
  const previous = roadmap.targetDate ?? null;
  const current = input.time ? timeFact(input.time, actor, at, sourceRef, input.sourceEventId, sourceLocation) : null;
  if (current) roadmap.targetDate = current;
  else delete roadmap.targetDate;
  roadmap.revision += 1;
  roadmap.updatedAt = at;
  roadmap.history.push({
    revision: roadmap.revision,
    action: 'target_date_changed',
    actor,
    at,
    targetDateChange: { previous, current },
  });
  recordCollaborationOperation(state, {
    ...replay,
    actorScope,
    resourceKind: 'roadmap',
    resourceId: roadmap.roadmapId,
    revision: roadmap.revision,
    recordedAt: at,
  });
  return structuredClone(roadmap);
}

/** Execution records the first real progress event; acceptance and an estimate do not start work. */
export function recordCollectiveActualStart(
  work: Work,
  actor: CollectiveCollaborationActor,
  at: string,
  eventId: string,
) {
  if (work.time?.actualStart) return;
  const current =
    observedWorkTime(work)?.actualStart ??
    timeFact({ value: at, timeZone: 'UTC' }, actor, at, `event:${eventId}`, eventId, work.sourceLocation);
  const change = applyTime(work, 'actualStart', current);
  const entry = work.history.at(-1);
  if (entry?.eventId === eventId) entry.timeChange = change;
}

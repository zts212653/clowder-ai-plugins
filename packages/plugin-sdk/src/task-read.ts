import type { PluginTaskEntrustedWorkSummary, PluginTaskReadItem, PluginTaskWait, PluginTaskWorkTime } from './module-host.js';

function invalid(field: string): never { throw new TypeError(`Task read projection has invalid ${field}`); }
function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(field);
  return value;
}
function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field);
}
function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(field);
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid(field);
  return value as T;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function workSummary(value: unknown): PluginTaskEntrustedWorkSummary {
  const work = record(value, 'entrustedWork');
  const revision = number(work.revision, 'entrustedWork.revision');
  if (!Number.isSafeInteger(revision) || revision < 0) invalid('entrustedWork.revision');
  const closure = record(work.closure, 'entrustedWork.closure');
  const admission = record(work.admission, 'entrustedWork.admission');
  const state = text(closure.state, 'entrustedWork.closure.state');
  if (!state || !Array.isArray(admission.sourceRefs)) invalid('entrustedWork');
  const time = work.time === undefined ? undefined : record(work.time, 'entrustedWork.time');
  const projectedTime: PluginTaskWorkTime = Object.fromEntries(
    (['businessDeadline', 'reviewBy', 'plannedStart', 'actualStart', 'estimatedCompletion'] as const).flatMap(key => {
      if (time?.[key] === undefined) return [];
      const fact = record(time[key], `entrustedWork.time.${key}`);
      const value = number(fact.value, `entrustedWork.time.${key}.value`);
      return [[key, {value, sourceRef: text(fact.sourceRef, `entrustedWork.time.${key}.sourceRef`)}]];
    }),
  );
  if (work.artifactRefs !== undefined && !Array.isArray(work.artifactRefs)) invalid('entrustedWork.artifactRefs');
  return { revision, ...(time === undefined ? {} : {time: projectedTime}),
    ...(work.artifactRefs === undefined ? {} : {artifactRefs: (work.artifactRefs as unknown[]).map(ref => text(ref, 'entrustedWork.artifactRefs'))}),
    closure: { state }, admission: {
    sourceRefs: admission.sourceRefs.map(ref => text(ref, 'entrustedWork.admission.sourceRefs')),
  } };
}

function generation(value: unknown, field: string): number {
  const result = number(value, field);
  if (!Number.isSafeInteger(result) || result < 0) invalid(field);
  return result;
}
function waitSummary(value: unknown): PluginTaskWait {
  const wait = record(value, 'pluginWait');
  const active = wait.await === undefined ? undefined : record(wait.await, 'pluginWait.await');
  const outcome = wait.waitOutcome === undefined ? undefined : record(wait.waitOutcome, 'pluginWait.waitOutcome');
  const ownerFence = outcome === undefined ? undefined : record(outcome.ownerFence, 'pluginWait.waitOutcome.ownerFence');
  return {
    pluginInstanceId: text(wait.pluginInstanceId, 'pluginWait.pluginInstanceId'),
    generation: generation(wait.generation, 'pluginWait.generation'),
    ...(active === undefined ? {} : { await: {
      generation: generation(active.generation, 'pluginWait.await.generation'),
      ...(active.expiresAt === undefined ? {} : { expiresAt: number(active.expiresAt, 'pluginWait.await.expiresAt') }),
    } }),
    ...(outcome === undefined ? {} : { waitOutcome: {
      outcomeId: text(outcome.outcomeId, 'pluginWait.waitOutcome.outcomeId'),
      generation: generation(outcome.generation, 'pluginWait.waitOutcome.generation'),
      ownerFence: {
        kind: choice(ownerFence!.kind, ['containing_task'], 'pluginWait.waitOutcome.ownerFence.kind'),
        generation: generation(ownerFence!.generation, 'pluginWait.waitOutcome.ownerFence.generation'),
      },
      reason: choice(outcome.reason, ['matched', 'subject_terminal', 'expired', 'owner_changed', 'superseded', 'user_cancel'],
        'pluginWait.waitOutcome.reason'),
      delivery: choice(outcome.delivery, ['pending', 'delivered', 'not_applicable', 'legacy_unfenced'],
        'pluginWait.waitOutcome.delivery'),
    } }),
  };
}

/** Project only declared read facts; never carry private Task authority from a richer Host record. */
export function projectTaskRead(value: unknown): PluginTaskReadItem | null {
  if (value === null) return null;
  const task = record(value, 'item');
  const userId = nullableText(task.userId, 'userId'); // Missing is incompatible, not an unowned Task.
  const result: PluginTaskReadItem = {
    id: text(task.id, 'id'), kind: choice(task.kind, ['work', 'pr_tracking', 'issue_tracking'], 'kind'),
    threadId: text(task.threadId, 'threadId'), subjectKey: nullableText(task.subjectKey, 'subjectKey'),
    title: text(task.title, 'title'), ownerCatId: nullableText(task.ownerCatId, 'ownerCatId'),
    status: choice(task.status, ['todo', 'doing', 'blocked', 'done'], 'status'), why: text(task.why, 'why'),
    createdBy: text(task.createdBy, 'createdBy'), createdAt: number(task.createdAt, 'createdAt'),
    updatedAt: number(task.updatedAt, 'updatedAt'), userId,
    ...(task.pluginWait === undefined ? {} : { pluginWait: waitSummary(task.pluginWait) }),
    ...(task.entrustedWork === undefined ? {} : { entrustedWork: workSummary(task.entrustedWork) }),
  };
  return freeze(result);
}
export function projectTaskReadList(value: unknown): readonly PluginTaskReadItem[] {
  if (!Array.isArray(value)) invalid('list');
  return Object.freeze(value.map(item => {
    const result = projectTaskRead(item);
    if (result === null) invalid('list item');
    return result;
  }));
}

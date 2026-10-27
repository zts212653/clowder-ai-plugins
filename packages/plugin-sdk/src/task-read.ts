import type {
  PluginTaskEntrustedWorkSummary,
  PluginTaskReadItem,
  PluginTaskWait,
  PluginTaskWorkTime,
} from './module-host.js';
import type {
  PluginTaskDataControllerBinding,
  PluginTaskDataControllerMutationResult,
  PluginTaskDataControllerSummary,
} from './task-data-controller.js';

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
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(field);
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
  const authorityRef = admission.authorityRef === undefined
    ? undefined
    : text(admission.authorityRef, 'entrustedWork.admission.authorityRef');
  const hostReceipt = admission.hostReceipt === undefined
    ? undefined
    : record(admission.hostReceipt, 'entrustedWork.admission.hostReceipt');
  const dataController = work.dataController === undefined
    ? undefined
    : dataControllerSummary(work.dataController);
  return { revision, ...(time === undefined ? {} : {time: projectedTime}),
    ...(work.artifactRefs === undefined ? {} : {artifactRefs: (work.artifactRefs as unknown[]).map(ref => text(ref, 'entrustedWork.artifactRefs'))}),
    closure: { state }, admission: {
    sourceRefs: admission.sourceRefs.map(ref => text(ref, 'entrustedWork.admission.sourceRefs')),
    ...(authorityRef === undefined ? {} : {authorityRef}),
    ...(hostReceipt === undefined ? {} : {hostReceipt: {
      receiptRef: text(hostReceipt.receiptRef, 'entrustedWork.admission.hostReceipt.receiptRef'),
      sourceRef: text(hostReceipt.sourceRef, 'entrustedWork.admission.hostReceipt.sourceRef'),
      catId: text(hostReceipt.catId, 'entrustedWork.admission.hostReceipt.catId'),
    }}),
  }, ...(dataController === undefined ? {} : {dataController}) };
}

function positiveRevision(value: unknown, field: string): number {
  const result = number(value, field);
  if (!Number.isSafeInteger(result) || result < 1) invalid(field);
  return result;
}

function controllerReceipt(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^task-data-controller:[a-f0-9]{64}$/.test(result)) invalid(field);
  return result;
}

function dataControllerBinding(value: unknown): PluginTaskDataControllerBinding {
  const binding = record(value, 'entrustedWork.dataController.binding');
  return {
    userId: text(binding.userId, 'entrustedWork.dataController.binding.userId'),
    catId: text(binding.catId, 'entrustedWork.dataController.binding.catId'),
    threadId: text(binding.threadId, 'entrustedWork.dataController.binding.threadId'),
    subjectKey: text(binding.subjectKey, 'entrustedWork.dataController.binding.subjectKey'),
    firstSourceRef: text(binding.firstSourceRef, 'entrustedWork.dataController.binding.firstSourceRef'),
    admissionAuthorityRef: text(
      binding.admissionAuthorityRef,
      'entrustedWork.dataController.binding.admissionAuthorityRef',
    ),
    pluginId: text(binding.pluginId, 'entrustedWork.dataController.binding.pluginId'),
    pluginInstanceId: text(binding.pluginInstanceId, 'entrustedWork.dataController.binding.pluginInstanceId'),
    moduleRef: text(binding.moduleRef, 'entrustedWork.dataController.binding.moduleRef'),
    lifecycleRevision: positiveRevision(
      binding.lifecycleRevision,
      'entrustedWork.dataController.binding.lifecycleRevision',
    ),
    ownerOperationReceiptRef: controllerReceipt(
      binding.ownerOperationReceiptRef,
      'entrustedWork.dataController.binding.ownerOperationReceiptRef',
    ),
  };
}

function dataControllerSummary(value: unknown): PluginTaskDataControllerSummary {
  const controller = record(value, 'entrustedWork.dataController');
  const state = choice(controller.state, ['active', 'revoked'], 'entrustedWork.dataController.state');
  const revocationReceiptRef = controller.revocationReceiptRef === undefined
    ? undefined
    : controllerReceipt(controller.revocationReceiptRef, 'entrustedWork.dataController.revocationReceiptRef');
  const currentForCaller = boolean(controller.currentForCaller, 'entrustedWork.dataController.currentForCaller');
  if ((state === 'revoked') !== (revocationReceiptRef !== undefined)) {
    invalid('entrustedWork.dataController.revocationReceiptRef');
  }
  if (state === 'revoked' && currentForCaller) invalid('entrustedWork.dataController.currentForCaller');
  return {
    bindingRevision: positiveRevision(controller.bindingRevision, 'entrustedWork.dataController.bindingRevision'),
    state,
    currentForCaller,
    binding: dataControllerBinding(controller.binding),
    ...(revocationReceiptRef === undefined ? {} : {revocationReceiptRef}),
  };
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
  const work = result.entrustedWork, controller = work?.dataController;
  const hostReceipt = work?.admission.hostReceipt;
  if (hostReceipt && (
    result.ownerCatId === null ||
    hostReceipt.receiptRef !== work?.admission.authorityRef ||
    hostReceipt.sourceRef !== work.admission.sourceRefs[0] ||
    hostReceipt.catId !== result.ownerCatId ||
    !hostReceipt.receiptRef.startsWith('message:') ||
    !hostReceipt.sourceRef.startsWith('message:')
  )) invalid('entrustedWork.admission.hostReceipt');
  if (controller?.currentForCaller && (!work ||
    controller.state !== 'active' ||
    result.userId === null ||
    result.ownerCatId === null ||
    result.subjectKey === null ||
    controller.binding.userId !== result.userId ||
    controller.binding.catId !== result.ownerCatId ||
    controller.binding.threadId !== result.threadId ||
    controller.binding.subjectKey !== result.subjectKey ||
    controller.binding.firstSourceRef !== work.admission.sourceRefs[0] ||
    controller.binding.admissionAuthorityRef !== work.admission.authorityRef
  )) invalid('entrustedWork.dataController.currentForCaller');
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

export function projectTaskDataControllerMutationResult(value: unknown): PluginTaskDataControllerMutationResult {
  const result = record(value, 'Task data-controller result');
  const disposition = choice(
    result.disposition,
    ['bound', 'revoked', 'replayed'] as const,
    'Task data-controller result.disposition',
  );
  const receiptRef = controllerReceipt(result.receiptRef, 'Task data-controller result.receiptRef');
  const bindingRevision = positiveRevision(
    result.bindingRevision,
    'Task data-controller result.bindingRevision',
  );
  const task = projectTaskRead(result.task);
  const controller = task?.entrustedWork?.dataController;
  if (
    !task ||
    !controller ||
    controller.bindingRevision !== bindingRevision ||
    (disposition === 'bound' &&
      (controller.state !== 'active' || !controller.currentForCaller ||
        controller.binding.ownerOperationReceiptRef !== receiptRef)) ||
    (disposition === 'revoked' &&
      (controller.state !== 'revoked' || controller.currentForCaller || controller.revocationReceiptRef !== receiptRef))
  ) {
    invalid('Task data-controller result.task');
  }
  return freeze({ disposition, receiptRef, bindingRevision, task });
}

import type {FeatureContext, PluginOwnerHttpContext} from '@clowder-ai/plugin-sdk';
import type {CollectiveConnector} from './business/connector/connector.js';
import {collectiveAcceptedWorkResultSchema, collectiveEventSourceIdentity, collectiveSourceIdentitySchema,
  type CollectiveAcceptedWorkResult} from './business/contracts/index.js';
import {classifyEntrustedWorkSourceTime} from './work-source-signals.js';
import {ownerWorkInput, ownerWorkResumeInput} from './owner-work-inputs.js';
import {collectiveWorkContinuation} from './owner-work-continuation.js';
import type {createCollectiveMessageWorkCaller} from './collective-message-work.js';
import {assertSettledCollectiveSource} from './collective-ingress-routing.js';
import {collectiveWorkClosure} from './collective-message-work.js';

const refusal = (code: string, message: string): never => {throw Object.assign(new Error(message), {code});};

/** The original browser callback: Service acceptance is authoritative; this
 * only reconciles the existing Host UI record. No execution is authorized here.
 * Validation below is ported from ca5 collective-work-result-routes.ts. */
export async function reconcileCollectiveMessageWorkResult(connector: CollectiveConnector,
  ports: Pick<FeatureContext, 'tasks' | 'messaging'>, ownerUserId: string, connectionId: string,
  unsafe: unknown, current: () => Promise<void>) {
  const input = collectiveAcceptedWorkResultSchema.parse(unsafe);
  await current();
  if (input.connectionId !== connectionId)
    refusal('COLLECTIVE_RESULT_CONNECTION_MISMATCH', 'Collective result belongs to another connection');
  return connector.withAssignedWorkAuthority(connectionId, input.workId, async ({connection, hostRoute, inbox, work}) => {
    await current();
    if (hostRoute?.localOwnerUserId !== ownerUserId)
      refusal('CONNECTOR_OWNER_MISMATCH', 'Collective Connector belongs to another local owner');
    if (!connectionMatches(input, connection))
      refusal('COLLECTIVE_RESULT_CONNECTION_MISMATCH', 'Collective result belongs to another connection');
    if (!acceptedWorkMatches(input, work, connection) || !work.assignment)
      refusal('COLLECTIVE_RESULT_NOT_CURRENT', 'Collective result is no longer current');
    const sources = inbox.filter(item => inboxSourceMatches(item, input, connection, work.assignment!.catId));
    const item = sources[0];
    if (sources.length !== 1 || item?.routeReceipt?.kind !== 'thread_message')
      return refusal('COLLECTIVE_RESULT_SOURCE_UNAVAILABLE', 'Collective Work has no unique local source');
    const source = collectiveEventSourceIdentity(item.event);
    if (!source || !ports.messaging.get)
      return refusal('COLLECTIVE_RESULT_SOURCE_UNAVAILABLE', 'Collective Work source is unavailable');
    const message = await ports.messaging.get(item.routeReceipt.messageId);await current();
    assertSettledCollectiveSource(message, item.routeReceipt, item.event, source, ownerUserId);
    const task = await ports.tasks.getBySubject(`collective-work:${connectionId}:${work.workId}`);await current();
    if (!task) return {result: 'not_admitted' as const};
    if ((task.userId !== null && task.userId !== ownerUserId) || task.ownerCatId !== work.assignment!.catId)
      return refusal('COLLECTIVE_RESULT_SOURCE_UNAVAILABLE', 'Collective Task does not match the accepted assignment');
    const contract = task.entrustedWork;
    if (!contract) return refusal('COLLECTIVE_RESULT_SOURCE_UNAVAILABLE', 'Collective Task has no original Work data');
    if (contract.closure.state === 'satisfied') return {result: 'already_closed' as const, taskId: task.id, revision: contract.revision};
    if (contract.closure.state !== 'open') return {result: 'terminal_unchanged' as const, taskId: task.id, revision: contract.revision};
    await current();
    const closed = await ports.tasks.updateIfThreadId(task.id, task.threadId, {entrustedWork: {
      expectedRevision: contract.revision, closure: {...collectiveWorkClosure, state: 'satisfied',
        evidenceRefs: [`collective:result:${input.resultEventId}`]},
    }});
    await current();
    if (!closed) return refusal('COLLECTIVE_RESULT_NOT_CURRENT', 'Collective Task changed during reconciliation');
    const latest = await ports.tasks.get(closed.id);await current();
    if (latest?.entrustedWork?.closure.state !== 'satisfied')
      return refusal('COLLECTIVE_RESULT_NOT_CURRENT', 'Collective closure projection is unavailable');
    return {result: 'closed' as const, taskId: closed.id, revision: latest.entrustedWork.revision};
  });
}

type Connection = Awaited<ReturnType<CollectiveConnector['getProjection']>>;
type Work = Awaited<ReturnType<CollectiveConnector['readAssignedWork']>>;
type InboxItem = Awaited<ReturnType<CollectiveConnector['listInbox']>>[number];

function connectionMatches(input: CollectiveAcceptedWorkResult, connection: Connection) {
  return (
    connection.authorityStatus === 'connected' &&
    connection.authorizedHumanId !== undefined &&
    input.serviceInstanceId === connection.serviceInstanceId &&
    input.collectiveId === connection.collectiveId
  );
}

function acceptedWorkMatches(input: CollectiveAcceptedWorkResult, work: Work, connection: Connection) {
  const assignment = work.assignment;
  return Boolean(
    assignment &&
      connection.authorizedHumanId &&
      work.revision === input.workRevision &&
      work.assignmentEventId === input.assignmentEventId &&
      work.resultEventId === input.resultEventId &&
      (work.resultRevision ?? 1) === input.resultRevision &&
      work.lifecycle === 'completed' &&
      work.status === 'completed' &&
      work.history.some(
        (entry) =>
          entry.action === 'result_accepted' &&
          entry.eventId === input.resultEventId &&
          (entry.resultRevision ?? 1) === input.resultRevision,
      ) &&
      assignment.connectionId === connection.connectionId &&
      assignment.humanId === connection.authorizedHumanId &&
      work.accountableHumanId === connection.authorizedHumanId,
  );
}

function inboxSourceMatches(
  item: InboxItem,
  input: CollectiveAcceptedWorkResult,
  connection: Connection,
  catId: string,
) {
  const recipient = item.event.recipient;
  return (
    item.event.eventId === input.assignmentEventId &&
    item.event.serviceInstanceId === input.serviceInstanceId &&
    item.event.collectiveId === input.collectiveId &&
    item.event.workRequest === 'entrust' &&
    item.disposition === 'routed' &&
    item.routeReceipt?.kind === 'thread_message' &&
    recipient?.kind === 'agent' &&
    recipient.connectionId === connection.connectionId &&
    recipient.humanId === connection.authorizedHumanId &&
    recipient.agentId === catId
  );
}

/** The retained Continue button uses its original strict DTO and Service round
 * predicate. The canonical Task contract revision is an optimistic UI snapshot only. */
export async function resumeCollectiveMessageWork(connector: CollectiveConnector,
  ports: Pick<FeatureContext, 'tasks' | 'messaging'>, caller: ReturnType<typeof createCollectiveMessageWorkCaller>,
  ownerUserId: string, connectionId: string, unsafe: unknown, current: () => Promise<void>) {
  const input = ownerWorkResumeInput.parse(unsafe);
  const snapshot = async () => {
    await current();const task = await ports.tasks.get(input.taskId);await current();
    if (!task?.entrustedWork || task.entrustedWork.closure.state !== 'open' || (task.userId !== null && task.userId !== ownerUserId) ||
      task.status === 'done' || !task.ownerCatId || task.entrustedWork.revision !== input.observedRevision ||
      !task.subjectKey?.startsWith(`collective-work:${connectionId}:`))
      return refusal('OWNER_ADMISSION_UNAVAILABLE', 'Current owner Task changed');
    return task;
  };
  const task = await snapshot();
  const workId = task.subjectKey!.slice(`collective-work:${connectionId}:`.length);
  const eventId = await connector.withAssignedWorkAuthority(connectionId, workId, async scope => {
    await current();
    if (scope.hostRoute?.localOwnerUserId !== ownerUserId)
      return refusal('CONNECTOR_OWNER_MISMATCH', 'Collective Connector belongs to another local owner');
    if (scope.work.assignment?.catId !== task.ownerCatId)
      return refusal('OWNER_ADMISSION_UNAVAILABLE', 'Collective assignment changed');
    const currentEventId = scope.work.executionAuthority?.eventId ?? scope.work.assignmentEventId;
    const items = scope.inbox.filter(item => item.event.eventId === currentEventId);
    const item = items[0], source = item && collectiveEventSourceIdentity(item.event);
    if (items.length !== 1 || !source || item?.routeReceipt?.kind !== 'thread_message')
      return refusal('COLLECTIVE_WORK_CONTINUATION_UNAVAILABLE', 'Current Collective execution source is unavailable');
    collectiveWorkContinuation(scope, source, item.routeReceipt.messageId);
    return source.eventId;
  });
  const check = async () => {
    const latest = await snapshot();
    if (latest.threadId !== task.threadId || latest.ownerCatId !== task.ownerCatId || latest.subjectKey !== task.subjectKey)
      refusal('OWNER_ADMISSION_UNAVAILABLE', 'Current owner Task changed');
  };
  const sent = await caller.send(connectionId, eventId, ownerUserId, check, {kind: 'resume', requestId: input.requestId, taskId: task.id});
  const message = await ports.messaging.get?.(sent.messageId);
  await check();
  if (!message || message.id !== sent.messageId || message.threadId !== task.threadId || message.userId !== ownerUserId)
    return refusal('OWNER_ADMISSION_UNAVAILABLE', 'Resumed Work message is unavailable');
  return {taskRef: `task:work:${task.id}`, revision: task.entrustedWork!.revision, messageId: sent.messageId,
    disposition: message.deliveryStatus ?? 'delivered'};
}

/** Original strict owner click for an existing Service commitment. HTTP caller
 * facts stay in the Host lane; the body supplies only the source and site choice. */
export async function admitCollectiveMessageWork(connector: CollectiveConnector,
  ports: Pick<FeatureContext, 'tasks' | 'messaging'>, caller: ReturnType<typeof createCollectiveMessageWorkCaller>,
  owner: PluginOwnerHttpContext, connectionId: string, unsafe: unknown, current: () => Promise<void>) {
  const input = ownerWorkInput.parse(unsafe);await current();
  const message = await ports.messaging.get?.(input.sourceMessageId);await current();
  const parsed = collectiveSourceIdentitySchema.safeParse(message?.source?.meta?.participation);
  if (!message || message.userId !== owner.userId || message.catId !== null || !parsed.success ||
    parsed.data.connectionId !== connectionId) return refusal('OWNER_ADMISSION_UNAVAILABLE', 'Collective source is unavailable');
  const source = parsed.data;
  await connector.sync(connectionId);await current();
  const work = message.source?.meta?.workRequest === 'continue'
    ? await connector.readAssignedWork(connectionId, String((message.source.meta.workExecutionNotice as {workId?: string})?.workId))
    : await connector.readAssignedWorkByAssignment(connectionId, source.eventId);
  await current();
  if (source.actor.kind === 'human') {
    const relations = [work.intendedOutcome, message.content].map(classifyEntrustedWorkSourceTime);
    if (relations.includes('ambiguous')) return {result: 'needs_clarification' as const, reason: 'ambiguous_source_time'};
    if (relations.includes('deadline') && !input.businessDeadline) return {result: 'needs_clarification' as const};
  } else {
    const task = await ports.tasks.getBySubject(`collective-work:${connectionId}:${work.workId}`);await current();
    if (!task || (input.threadId && task.threadId !== input.threadId))
      return refusal('OWNER_ADMISSION_UNAVAILABLE', 'The registered Work has not yet been delivered');
  }
  const sent = await caller.send(connectionId, source.eventId, owner.userId, current,
    {kind: 'manual', sourceMessageId: message.id, owner, ...(input.threadId ? {threadId: input.threadId} : {}),
      ...(input.businessDeadline !== undefined ? {businessDeadline: input.businessDeadline} : {})});
  const task = await ports.tasks.getBySubject(`collective-work:${connectionId}:${work.workId}`);
  const stored = await ports.messaging.get?.(sent.messageId);await current();
  if (!task?.entrustedWork || !stored || stored.threadId !== task.threadId || stored.userId !== owner.userId)
    return refusal('OWNER_ADMISSION_UNAVAILABLE', 'Work delivery is unavailable');
  return {taskRef: `task:work:${task.id}`, revision: task.entrustedWork.revision, messageId: sent.messageId,
    disposition: stored.deliveryStatus ?? 'delivered'};
}

import { isDeepStrictEqual } from 'node:util';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';
import type { CollectiveConnector } from './business/connector/connector.js';
import type { CollectiveEventEnvelope, CollectiveWorkProjection } from './business/contracts/index.js';
import { collectiveEventSourceIdentity } from './business/contracts/index.js';
import { assertSettledCollectiveSource } from './collective-ingress-routing.js';
import {locateCollectiveWorkTask} from './collective-work-thread.js';

const unavailable = () => Object.assign(new Error('Collective Work wake no longer has one current open Task and source'),
  {code: 'COLLECTIVE_WORK_WAKE_NOT_CURRENT'});

/** Service wake notices reuse an existing Task. They never establish a new admission or authority. */
export async function readCollectiveWorkWake(connector: CollectiveConnector,
  ports: Pick<FeatureContext, 'tasks' | 'messaging' | 'storage' | 'pluginInstanceId'>, connectionId: string, eventId: string,
  ownerUserId: string, current: () => Promise<void>, phase: 'delivery' | 'execution' = 'delivery') {
  await current();
  const wake = (await connector.listInbox(connectionId)).find(row => row.event.eventId === eventId);
  const notice = wake?.event.workWakeNotice;
  if (!wake || !notice) throw unavailable();
  return connector.withAssignedWorkAuthority(connectionId, notice.workId, async scope => {
    await current();
    const {work, connection, hostRoute, inbox} = scope;
    assertCurrentWorkWake(wake.event, work, phase);
    if (hostRoute?.localOwnerUserId !== ownerUserId || connection.authorityStatus !== 'connected' ||
        connection.authorizedHumanId !== work.accountableHumanId) throw unavailable();
    const birth = inbox.filter(row => row.event.eventId === work.assignmentEventId);
    const sources = inbox.filter(row => row.event.eventId === (work.executionAuthority?.eventId ?? work.assignmentEventId));
    const item = sources[0], initial = birth[0];
    const source = item && collectiveEventSourceIdentity(item.event);
    const birthSource = initial && collectiveEventSourceIdentity(initial.event);
    if (sources.length !== 1 || birth.length !== 1 || !item || !initial || !source || !birthSource ||
        item.routeReceipt?.kind !== 'thread_message' || initial.routeReceipt?.kind !== 'thread_message') throw unavailable();
    const message = await ports.messaging.get(item.routeReceipt.messageId);await current();
    const first = await ports.messaging.get(initial.routeReceipt.messageId);await current();
    assertSettledCollectiveSource(message, item.routeReceipt, item.event, source, ownerUserId);
    assertSettledCollectiveSource(first, initial.routeReceipt, initial.event, birthSource, ownerUserId);
    if (!first) throw unavailable();
    const located = await locateCollectiveWorkTask(ports.tasks, ports.storage, first, source.catId,
      ports.pluginInstanceId);await current();
    const task = located?.task;
    if (!message || !first || !task?.entrustedWork || task.kind !== 'work' || task.status === 'done' ||
        task.entrustedWork.closure.state !== 'open' || task.ownerCatId !== source.catId ||
        (task.userId !== null && task.userId !== ownerUserId) ||
        task.entrustedWork.admission.sourceRefs.length !== 1 ||
        task.entrustedWork.admission.sourceRefs[0] !== `message:${first.id}`) throw unavailable();
    if (!isDeepStrictEqual(work, await scope.readCurrentWork())) throw unavailable();
    await current();
    return {wake, item, source, message, first, work, task, hostRoute};
  });
}

export function assertCurrentWorkWake(event: CollectiveEventEnvelope, work: CollectiveWorkProjection,
  phase: 'delivery' | 'execution' = 'delivery') {
  const notice = event.workWakeNotice, assignment = work.assignment, recipient = event.recipient;
  // Delivery consumes the exact observation. An admitted invocation instead
  // follows the same assignment/execution: its own date/progress CAS advances
  // business revision without issuing a new execution permission.
  const revisionCurrent = notice && (phase === 'delivery'
    ? work.revision === notice.workRevision : work.revision >= notice.workRevision);
  if (event.actor.kind !== 'human' || event.workRequest !== 'resume' || !notice || !assignment || !work.assignmentEventId ||
      !['committed', 'in_progress'].includes(work.lifecycle) || work.workId !== notice.workId || !revisionCurrent ||
      work.assignmentEventId !== notice.assignmentEventId || (work.executionAuthority?.revision ?? 1) !== notice.executionRevision ||
      work.executionStatus?.state === 'unavailable' || recipient?.kind !== 'agent' || recipient.connectionId !== assignment.connectionId ||
      recipient.humanId !== assignment.humanId || recipient.agentId !== assignment.catId ||
      recipient.participationRevision !== (work.executionAuthority?.participationRevision ?? assignment.participationRevision) ||
      !wakeReasonMatches(work, event)) throw unavailable();
}
function wakeReasonMatches(work: CollectiveWorkProjection, event: CollectiveEventEnvelope) {
  const notice = event.workWakeNotice;
  if (!notice) return false;
  if (notice.reason === 'dependency_completed')
    return Boolean(notice.dependencyWorkId && work.dependencyWorkIds.includes(notice.dependencyWorkId) && work.status !== 'blocked');
  const referenced = event.replyToEventId;
  if (!referenced) return false;
  return [work.sourceEventId, work.assignmentEventId, work.resultEventId, work.executionAuthority?.eventId,
    work.executionAuthority?.sourceEventId, ...work.history.flatMap(entry => [entry.eventId,
      ...(entry.action === 'execution_authorized' ? [entry.note] : [])])].includes(referenced) ||
    event.location?.rootEventId === (work.sourceLocation.rootEventId ?? work.sourceEventId);
}

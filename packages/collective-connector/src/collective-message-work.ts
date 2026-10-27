import { readCollectiveActionSource } from './collective-action-source.js';
import {isDeepStrictEqual} from 'node:util';
import type {FeatureContext, PluginActionContext, PluginOwnerHttpContext} from '@clowder-ai/plugin-sdk';
import type {CollectiveConnector} from './business/connector/connector.js';
import type {ConnectorInboxItem, HostRouteConfig} from './business/connector/index.js';
import type {CollectiveSourceIdentity} from './business/contracts/index.js';
import {collectiveEventSourceIdentity, collectiveSourceIdentitySchema, collectiveWorkAssignmentMatches,
  collectiveWorkExecutionMatches} from './business/contracts/index.js';
import {resolveMaterializedParticipation} from './business/connector/participation-custody.js';
import {collectiveContextError} from './collective-context-refs.js';
import {assertSettledCollectiveSource, collectiveSource, ingressIdempotencyKey} from './collective-ingress-routing.js';
import {resolveHumanMessageWork} from './collective-human-message-work.js';
import {locateCollectiveWorkTask, resolveCollectiveWorkThread} from './collective-work-thread.js';
import {collectiveWorkArtifactRefsSchema} from './work-native-methods.js';
import {readCollectiveWorkWake} from './collective-work-wake.js';

const changed = () => collectiveContextError('WORK_EXECUTION_NOT_CURRENT', 'The Collective source or current Service permission changed');
const subjectKey = (connectionId: string, workId: string) => `collective-work:${connectionId}:${workId}`;
type Delivery = {kind: 'resume'; requestId: string; taskId: string}
  | {kind: 'manual'; sourceMessageId: string; owner: PluginOwnerHttpContext; threadId?: string; businessDeadline?: number};
type Ports = Pick<FeatureContext, 'pluginInstanceId' | 'tasks' | 'threads' | 'messaging' | 'storage'>;

export const collectiveWorkClosure = Object.freeze({
  condition: 'A reviewable result answers the entrusted request at its original Collective location',
  expectedSignal: 'collective:accepted-result',
});

/** The original Task/Schedule contract preserves the UI/result association.
 * This data record is not an execution receipt: Registry authenticates the call and Service authorizes Work. */
export function createCollectiveMessageWorkCaller(connector: CollectiveConnector, context: Ports,
  options?: {beforeWake(threadId: string): Promise<void>}) {
  async function canonicalSource(route: HostRouteConfig, item: ConnectorInboxItem, source: CollectiveSourceIdentity,
    humanId: string, ownerUserId: string, current: () => Promise<void>) {
    const destination = resolveMaterializedParticipation(route, humanId, source.catId, source.location.channelId);
    if (!destination || !context.messaging.get || (item.routeReceipt && item.routeReceipt.kind !== 'thread_message')) throw changed();
    const projected = collectiveSource(item.event, source);
    let receipt = item.routeReceipt;
    if (!receipt) {
      await connector.beginInboxRouting(source.connectionId, source.eventId, route.revision);await current();
      const sent = await context.messaging.send(destination.threadId, {idempotencyKey: ingressIdempotencyKey(item.event),
        identity: 'collective', sender: projected.sender, meta: projected.meta,
        payload: {provenance: {origin: {kind: 'plugin', instanceId: context.pluginInstanceId}, epistemicStatus: 'observation'},
          elements: [{elementId: 'collective-source', kind: 'text', payload: {text: item.event.body}}]}});
      if (sent.threadId !== destination.threadId) {
        if (item.disposition !== 'routing') throw changed();
        assertSettledCollectiveSource(await context.messaging.get(sent.messageId), sent, item.event, source, ownerUserId);
      }
      receipt = {kind: 'thread_message', threadId: sent.threadId, messageId: sent.messageId, catId: source.catId};
      await connector.completeInboxRouting(source.connectionId, source.eventId, route.revision, receipt);await current();
    }
    const message = await context.messaging.get(receipt.messageId);await current();
    assertSettledCollectiveSource(message, receipt, item.event, source, ownerUserId);
    if (!message) throw changed();
    return message;
  }
  async function read(action: PluginActionContext) {
    await action.assertCurrent();
    const auth = await readCollectiveActionSource(context, action);
    if (auth.source.catId !== null || auth.source.source?.connector !== 'collective') throw changed();
    const parsed = collectiveSourceIdentitySchema.safeParse(auth.source.source!.meta?.participation);
    if (!parsed.success || parsed.data.catId !== auth.catId) throw changed();
    let source = parsed.data;
    let item = (await connector.listInbox(source.connectionId)).find(row => row.event.eventId === source.eventId);
    if (!item || !isDeepStrictEqual(collectiveEventSourceIdentity(item.event), source) || item.event.body !== auth.source.content ||
      !isDeepStrictEqual(collectiveSource(item.event, source).meta, auth.source.source!.meta) ||
      !['entrust', 'continue', 'resume'].includes(String(item.event.workRequest))) throw changed();
    if (item.event.workRequest === 'resume') {
      const wake = await readCollectiveWorkWake(connector, context, source.connectionId, source.eventId, auth.userId,
        action.assertCurrent, 'execution');
      source = wake.source;item = wake.item;
    }
    const workId = source.actor.kind === 'agent'
      ? item.event.workExecutionNotice?.workId ?? item.event.workAcceptanceNotice?.workId
      : (await connector.readAssignedWorkByAssignment(source.connectionId, source.eventId)).workId;
    if (!workId) throw changed();
    // The original inbox source stays in its participation thread; ordinary
    // Work send wakes the original private child thread. Neither message is a Task receipt.
    const route = await connector.getHostRoute(source.connectionId);
    if (!route || route.localOwnerUserId !== auth.userId) throw changed();
    if (item.routeReceipt?.kind !== 'thread_message' || !context.messaging.get) throw changed();
    const original = await context.messaging.get(item.routeReceipt.messageId);await action.assertCurrent();
    assertSettledCollectiveSource(original, item.routeReceipt, item.event, source, auth.userId);
    if (!original) throw changed();
    const preliminary = source.actor.kind === 'agent' ? await connector.resolveAcceptedWorkGrant(source) : undefined;
    const observedWork = preliminary?.work ?? await connector.readAssignedWorkByAssignment(source.connectionId, source.eventId);
    let taskSource = original;
    if (observedWork.assignmentEventId !== source.eventId) {
      const firstRows = (await connector.listInbox(source.connectionId)).filter(row => row.event.eventId === observedWork.assignmentEventId);
      const first = firstRows[0], firstIdentity = first && collectiveEventSourceIdentity(first.event);
      if (firstRows.length !== 1 || !first || !firstIdentity || firstIdentity.catId !== source.catId ||
        first.routeReceipt?.kind !== 'thread_message') throw changed();
      const firstMessage = await context.messaging.get(first.routeReceipt.messageId);await action.assertCurrent();
      assertSettledCollectiveSource(firstMessage, first.routeReceipt, first.event, firstIdentity, auth.userId);
      if (!firstMessage) throw changed();
      taskSource = firstMessage;
    }
    const located = await locateCollectiveWorkTask(context.tasks, context.storage, taskSource, source.catId,
      context.pluginInstanceId);await action.assertCurrent();
    const task = located?.task;
    if (!task?.entrustedWork || task.entrustedWork.closure.state !== 'open' ||
      (task.userId !== null && task.userId !== auth.userId) || task.ownerCatId !== auth.catId || task.threadId !== auth.threadId) throw changed();
    const human = source.actor.kind === 'human' ? await resolveHumanMessageWork(connector, context.storage, source,
      original, auth.userId, action.assertCurrent, {mode: 'read', hasTask: true, time: task.entrustedWork.time}) : undefined;
    const granted = source.actor.kind === 'agent' ? preliminary : undefined;
    await action.assertCurrent();
    const work = human?.work ?? granted!.work, authority = work.executionAuthority ?? work.acceptance;
    const executionRevision = work.executionAuthority?.revision ?? 1;
    const resultRevision = human?.resultRevision ?? work.executionAuthority?.resultRevision ?? 1;
    if (work.workId !== workId || work.workId !== observedWork.workId || !work.assignmentEventId ||
      !['committed', 'in_progress', 'result_ready'].includes(work.lifecycle) ||
      (item.event.workRequest === 'continue'
        ? !collectiveWorkExecutionMatches(source, work, item.event.workExecutionNotice)
        : executionRevision !== 1 || !collectiveWorkAssignmentMatches(source, work, item.event.workAcceptanceNotice))) throw changed();
    const receiptRef = `message:${auth.source.id}`;
    if (source.actor.kind === 'agent' && authority && authority.hostAdmission?.state !== 'admitted') {
      await connector.recordHostAdmission(source.connectionId, {workId, assignmentEventId: work.assignmentEventId,
        operationRef: authority.operationRef, grantRef: authority.grantRef, grantRevision: authority.grantRevision,
        executionRevision, disposition: {state: 'admitted', receiptRef}});
      await action.assertCurrent();
    }
    // Admission acknowledges the first delivery. A later authenticated owner
    // resume has a different message; its current Service grant is rechecked above.
    const connection = await connector.getProjection(source.connectionId);
    const participation = resolveMaterializedParticipation(route, connection.authorizedHumanId ?? '', auth.catId, source.location.channelId);
    const latestItem = (await connector.listInbox(source.connectionId)).find(row => row.event.eventId === source.eventId);
    if (!participation || connection.authorityStatus !== 'connected' || connection.authorizedHumanId !== work.accountableHumanId ||
      !latestItem || !isDeepStrictEqual(latestItem.routeReceipt, item.routeReceipt)) throw changed();
    await connector.readParticipationContext(source, 0, 1);
    await action.assertCurrent();
    if (!isDeepStrictEqual(await context.messaging.get(original.id), original)) throw changed();
    return {auth, source, sourceRef: `message:${original.id}` as `message:${string}`, resultKey: `work:${task.id}`,
      displayName: participation.displayName,
      // Date, explicit selection and closure share the original Task data version;
      // Service executionRevision is independent.
      work: {workId, revision: task.entrustedWork.revision, resultRevision, executionRevision, assignmentEventId: work.assignmentEventId},
      artifactRefs: task.entrustedWork.artifactRefs ?? [],
      time: task.entrustedWork.time,
      refScope: `${receiptRef}:work:${workId}:result:${resultRevision}:execution:${executionRevision}`};
  }
  return Object.freeze({
    async wake(connectionId: string, eventId: string, ownerUserId: string, current: () => Promise<void>) {
      const binding = await readCollectiveWorkWake(connector, context, connectionId, eventId, ownerUserId, current);
      const {source, message, task, work, wake, hostRoute} = binding;
      if (source.actor.kind === 'human')
        await resolveHumanMessageWork(connector, context.storage, source, message, ownerUserId, current,
          {mode: 'read', hasTask: true, time: task.entrustedWork!.time});
      else {
        const grant = await connector.resolveAcceptedWorkGrant(source);await current();
        if (grant.work.workId !== work.workId || !isDeepStrictEqual(grant.work, work)) throw changed();
      }
      const assertWakeCurrent = async () => {
        const latest = await readCollectiveWorkWake(connector, context, connectionId, eventId, ownerUserId, current);
        if (!isDeepStrictEqual(latest.work, work) || !isDeepStrictEqual(latest.task, task)) throw changed();
      };
      await current();await options?.beforeWake(task.threadId);await current();await assertWakeCurrent();
      const projected = collectiveSource(wake.event);
      await connector.beginInboxRouting(connectionId, eventId, hostRoute.revision);await current();
      await assertWakeCurrent();
      const sent = await context.messaging.send(task.threadId, {idempotencyKey: `collective-work-wake:${wake.event.eventId}`,
        identity: 'collective', sender: projected.sender, meta: projected.meta, wake: {catId: source.catId},
        payload: {provenance: {origin: {kind: 'plugin', instanceId: context.pluginInstanceId}, epistemicStatus: 'observation'},
          elements: [{elementId: 'collective-source', kind: 'text', payload: {text: wake.event.body}}]}});
      if (sent.threadId !== task.threadId) throw changed();
      await current();
      const latest = await readCollectiveWorkWake(connector, context, connectionId, eventId, ownerUserId, current);
      if (!isDeepStrictEqual(latest.work, work) || !isDeepStrictEqual(latest.task, task)) throw changed();
      await connector.completeInboxRouting(connectionId, eventId, hostRoute.revision,
        {kind: 'thread_message', threadId: sent.threadId, messageId: sent.messageId, catId: source.catId});
      await current();return sent;
    },
    async withCurrentMessage<T>(action: PluginActionContext, consume: (binding: Awaited<ReturnType<typeof read>> &
      {revalidate(): Promise<void>; registerArtifactRefs(expectedRevision: number, artifactRefs: readonly string[]): Promise<void>}) => Promise<T>) {
      let initial = await read(action);
      let live = true;
      const revalidate = async () => {
        if (!live) throw changed();
        const latest = await read(action);
        if (!live || !isDeepStrictEqual(latest, initial)) throw changed();
      };
      const binding = {...initial, revalidate, registerArtifactRefs: async (expectedRevision: number, artifactRefs: readonly string[]) => {
        const refs = collectiveWorkArtifactRefsSchema.parse(artifactRefs);
        await revalidate();
        if (expectedRevision !== initial.work.revision)
          throw collectiveContextError('WORK_ARTIFACT_REVISION_CONFLICT', 'Task data changed; reread current context');
        const updated = await context.tasks.update(initial.resultKey.slice('work:'.length), { entrustedWork: { expectedRevision, artifactRefs: refs } }, { expectedThreadId: initial.auth.threadId });
        if (!updated || !live) throw changed();
        const latest = await read(action);
        // Rebase only this successful, exact data CAS. Source/Service/invocation,
        // ownership, date and execution facts must all remain byte-for-byte equal.
        if (!live || latest.work.revision !== expectedRevision + 1 || !isDeepStrictEqual(latest.artifactRefs, refs) ||
          !isDeepStrictEqual({...latest, work: {...latest.work, revision: initial.work.revision}, artifactRefs: initial.artifactRefs}, initial)) throw changed();
        initial = latest;Object.assign(binding, latest);
      }};
      try {
        const result = await consume(binding);
        await revalidate();
        return result;
      } finally {live = false;}
    },
    /** Current registered Service grant supplies permission. The Task data lifecycle
     * keeps the pre-existing Schedule record; ordinary send owns storage/wake/dedup. */
    async send(connectionId: string, eventId: string, ownerUserId: string, current: () => Promise<void>,
      delivery?: Delivery) {
      await current();
      return connector.withInboxRoutingAuthority(connectionId, eventId, async (route, item) => {
        await current();
        const source = collectiveEventSourceIdentity(item.event);
        if (!source || route.localOwnerUserId !== ownerUserId) throw changed();
        const grant = source.actor.kind === 'agent' ? await connector.resolveAcceptedWorkGrant(source) : undefined;await current();
        const projection = await connector.getProjection(connectionId);
        const original = await canonicalSource(route, item, source, projection.authorizedHumanId ?? '', ownerUserId, current);
        const projected = collectiveSource(item.event, source);
        const workId = grant?.work.workId ?? (await connector.readAssignedWorkByAssignment(connectionId, source.eventId)).workId;
        const manual = delivery?.kind === 'manual' ? delivery : undefined;
        const resume = delivery?.kind === 'resume' ? delivery : undefined;
        if (manual && (manual.sourceMessageId !== original.id || manual.owner.pluginInstanceId !== context.pluginInstanceId ||
          manual.owner.userId !== ownerUserId || manual.owner.operation !== 'write')) throw changed();
        let birth = original;
        const authorizedWork = source.actor.kind === 'human'
          ? await connector.readAssignedWorkByAssignment(connectionId, source.eventId)
          : grant!.work;
        if (!authorizedWork.assignmentEventId) throw changed();
        if (authorizedWork.assignmentEventId !== source.eventId) {
          const first = (await connector.listInbox(connectionId)).find(row => row.event.eventId === authorizedWork.assignmentEventId);
          const firstIdentity = first && collectiveEventSourceIdentity(first.event);
          if (!first || !firstIdentity || firstIdentity.catId !== source.catId || first.event.workRequest !== 'entrust') throw changed();
          // The current Service grant authorizes this execution. Its first
          // assignment only preserves the original private-thread site policy.
          birth = await canonicalSource(route, first, firstIdentity, projection.authorizedHumanId ?? '', ownerUserId, current);
        }
        const site = await resolveCollectiveWorkThread(context.threads, context.tasks, birth, source.catId,
          context.pluginInstanceId, context.storage, manual?.threadId ? {threadId:manual.threadId} : {});await current();
        const locatedExisting = site.kind === 'existing'
          ? await locateCollectiveWorkTask(context.tasks,context.storage,birth,source.catId,context.pluginInstanceId)
          : undefined;await current();
        const existing = locatedExisting?.task ?? null;
        if (site.kind === 'existing' && locatedExisting?.site.taskId !== site.taskId) throw changed();
        if (site.kind === 'existing' && (!existing?.entrustedWork || existing.entrustedWork.closure.state !== 'open')) throw changed();
        const time = existing?.entrustedWork?.time ?? (manual?.businessDeadline ? {
          businessDeadline: {value: manual.businessDeadline, sourceRef: `message:${original.id}`},
        } : undefined);
        if (existing && manual?.businessDeadline !== undefined &&
          time?.businessDeadline?.value !== manual.businessDeadline) throw changed();
        const human = source.actor.kind === 'human' ? await resolveHumanMessageWork(connector, context.storage, source,
          original, ownerUserId, current, {mode: 'send', hasTask: !!existing, ...(manual ? {manual: manual.owner} : {}),
            resume: !!resume,time,...(existing?{existingTask:existing,pluginInstanceId:context.pluginInstanceId}:{})}) : undefined;
        const work = human?.work ?? grant!.work;
        const resultRevision = human?.resultRevision ?? work.executionAuthority?.resultRevision ?? 1;
        if (!work.assignmentEventId || work.workId !== authorizedWork.workId ||
          (existing && manual?.threadId && existing.threadId !== manual.threadId)) throw changed();
        if (manual?.threadId) {
          const owned = await context.threads.get(manual.threadId);await current();
          if (!owned) throw changed();
          if (!(await context.threads.getCats(owned.id)).participants.some(cat => cat.catId === source.catId)) {
            await context.threads.addParticipants({threadId: owned.id, catIds: [source.catId]});await current();
          }
        }
        const threadId = site.threadId;
        const written = existing ?? await context.tasks.create({ subjectKey: subjectKey(connectionId, work.workId), kind: 'work',
    threadId, ownerCatId: source.catId, title: work.title, why: work.intendedOutcome,
    entrustedWork: { sourceMessageId: birth.id, intendedOutcome: work.intendedOutcome, closure: collectiveWorkClosure,
        ...(time ? { time } : {}) } }, { onConflict: "update" });
        const locatedTask = await locateCollectiveWorkTask(context.tasks,context.storage,birth,source.catId,
          context.pluginInstanceId);await current();
        const task = locatedTask?.task;
        if (!task?.entrustedWork || task.entrustedWork.closure.state !== 'open' ||
          task.id !== written.id || (task.userId !== null && task.userId !== ownerUserId) ||
          task.ownerCatId !== source.catId || task.threadId !== threadId) throw changed();
        if (resume && (task.id !== resume.taskId || task.status === 'done')) throw changed();
        if (human?.bindTask && !human.binding) {
          const controller = task.entrustedWork.dataController;
          await human.bindTask({taskRef:`task:work:${task.id}`,taskRevision:task.entrustedWork.revision,
            threadId:task.threadId,admissionRef:`message:${birth.id}`,executionRef:`message:${original.id}`,
            refScope:`message:${original.id}:work:${work.workId}:result:${resultRevision}:execution:${work.executionAuthority?.revision ?? 1}`,
            ...(controller?.state === 'active'
              ? {dataControllerReceiptRef:controller.binding.ownerOperationReceiptRef} : {})});
          await current();
        }
        const assertTaskCurrent = async () => {
          const latest = await locateCollectiveWorkTask(context.tasks,context.storage,birth,source.catId,
            context.pluginInstanceId);await current();
          if (!latest || !isDeepStrictEqual(latest.task,task)) throw changed();
        };
        await options?.beforeWake(threadId);await current();await assertTaskCurrent();
        const sent = await context.messaging.send(threadId, {idempotencyKey: resume
          ? `collective-work-resume:${task.id}:${resume.requestId}`
          : `collective-work:${original.id}:${source.catId}${source.actor.kind === 'human' && resultRevision > 1 ? `:result:${resultRevision}` : ''}`,
          identity: 'collective', sender: projected.sender, meta: projected.meta, wake: {catId: source.catId},
          payload: {provenance: {origin: {kind: 'plugin', instanceId: context.pluginInstanceId}, epistemicStatus: 'observation'},
            elements: [{elementId: 'collective-source', kind: 'text', payload: {text: item.event.body}}]}});
        if (sent.threadId !== threadId) throw changed();
        await current();await assertTaskCurrent();
        if (source.actor.kind === 'human') {
          await resolveHumanMessageWork(connector, context.storage, source, original, ownerUserId, current,
            {mode: 'read', hasTask: true, time: task.entrustedWork.time});
        } else {
          const latest = await connector.resolveAcceptedWorkGrant(source);await current();
          const authority = latest.work.executionAuthority ?? latest.work.acceptance;
          if (!authority || latest.work.workId !== work.workId || !latest.work.assignmentEventId) throw changed();
          const receiptRef = `message:${sent.messageId}`;
          if (authority.hostAdmission?.state !== 'admitted') {
            await connector.recordHostAdmission(connectionId, {workId: work.workId, assignmentEventId: latest.work.assignmentEventId,
              operationRef: authority.operationRef, grantRef: authority.grantRef, grantRevision: authority.grantRevision,
              executionRevision: latest.work.executionAuthority?.revision ?? 1, disposition: {state: 'admitted', receiptRef}});
          } else if (!resume && authority.hostAdmission.receiptRef !== receiptRef) throw changed();
        }
        await current();
        return sent;
      });
    },
  });
}

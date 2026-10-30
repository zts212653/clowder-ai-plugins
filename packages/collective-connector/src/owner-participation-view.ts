import {
  type CollectiveConnector,
  defaultDesiredParticipation,
  type HostRouteConfig,
} from './business/connector/index.js';
import type { OwnerViewMessageStore as IMessageStore } from './owner-participation-host-types.js';
import type { OwnerViewTaskStore as ITaskStore } from './owner-participation-host-types.js';
import type { OwnerViewThreadStore as IThreadStore } from './owner-participation-host-types.js';
import {
  currentParticipationCats,
  type ParticipationCat,
  preserveInitialExclusions,
} from './participation-reconciler.js';
import { ownerRequestExecution } from './collective-owner-request-progress.js';
import type {PluginStorageHost} from '@clowder-ai/plugin-sdk';
import {readWorkFirstReceipt} from './owner-work-first-receipt.js';

interface ViewOptions {
  readonly cats: () => readonly ParticipationCat[];
  readonly threads: Pick<IThreadStore, 'list'>;
  readonly messages: Pick<IMessageStore, 'getById'>;
  readonly tasks: Pick<ITaskStore, 'list'>;
  readonly storage?: Pick<PluginStorageHost, 'get'>;
}

interface ViewAuthority {
  readonly connector: Pick<CollectiveConnector, 'listInbox' | 'isParticipationPublished'>;
  readonly connection: Awaited<ReturnType<CollectiveConnector['getProjection']>>;
  readonly route?: HostRouteConfig;
  readonly userId: string;
}

export async function collectiveOwnerParticipationView(options: ViewOptions, auth: ViewAuthority) {
  const inbox = await auth.connector.listInbox(auth.connection.connectionId);
  const replies = new Map<string, (typeof inbox)[number]['event'][]>();
  for (const { event } of inbox) {
    if (!event.replyToEventId) continue;
    const group = replies.get(event.replyToEventId) ?? [];
    group.push(event);
    replies.set(event.replyToEventId, group);
  }
  const sources = new Set(
    inbox.flatMap((item) =>
      item.routeReceipt?.kind === 'thread_message' ? [`message:${item.routeReceipt.messageId}`] : [],
    ),
  );
  const tasks = await options.tasks.list({ kind: 'work' });
  const published = await auth.connector.isParticipationPublished(auth.connection.connectionId).catch(() => false);
  const registeredCats = options.cats();
  const profiles = new Map(registeredCats.map((cat) => [cat.id, cat]));
  const cats = currentParticipationCats(auth.route?.observedEligibility ?? {}, registeredCats);
  const workByEvent = new Map<string, string>();
  for (const item of inbox) {
    const notice = item.event.workExecutionNotice ?? item.event.workAcceptanceNotice;
    if (notice) workByEvent.set(item.event.eventId, notice.workId);
    if (item.event.workExecutionNotice)
      workByEvent.set(item.event.workExecutionNotice.assignmentEventId, item.event.workExecutionNotice.workId);
    if (options.storage && item.event.actor.kind === 'human' && item.event.workRequest === 'entrust' &&
      item.routeReceipt?.kind === 'thread_message' && item.event.recipient?.kind === 'agent') {
      const choice = await readWorkFirstReceipt(options.storage, auth.userId,
        item.routeReceipt.messageId, item.event.recipient.agentId);
      if (choice) workByEvent.set(item.event.eventId, choice.work.workId);
    }
  }
  const referencedThreadIds = new Set(
    inbox.flatMap((item) => item.routeReceipt?.kind === 'thread_message' ? [item.routeReceipt.threadId] : []),
  );
  if (auth.route) {
    referencedThreadIds.add(auth.route.defaultIngressThreadId);
    referencedThreadIds.add(auth.route.humanNotificationThreadId);
    for (const binding of Object.values(auth.route.agentRoutes)) referencedThreadIds.add(binding.threadId);
    for (const endpoint of Object.values(auth.route.channelRoutes)) referencedThreadIds.add(endpoint.threadId);
  }
  const taskSourceRefs = new Map<string, readonly string[]>();
  for (const task of tasks) {
    const work = task.entrustedWork;
    if (work) {
      if (task.userId === auth.userId && work.admission.sourceRefs.some((ref) => sources.has(ref))) {
        taskSourceRefs.set(task.id, work.admission.sourceRefs);
        referencedThreadIds.add(task.threadId);
      }
      continue;
    }
    if ((task.userId !== null && task.userId !== auth.userId) || !task.ownerCatId) continue;
    const sourceRefs = inbox.flatMap((item) => {
      const workId = workByEvent.get(item.event.eventId);
      const recipient = item.event.recipient;
      return workId && task.subjectKey === `collective-work:${auth.connection.connectionId}:${workId}` &&
        recipient?.kind === 'agent' && recipient.connectionId === auth.connection.connectionId &&
        recipient.agentId === task.ownerCatId && item.routeReceipt?.kind === 'thread_message'
        ? [`message:${item.routeReceipt.messageId}`] : [];
    });
    if (sourceRefs.length) {
      taskSourceRefs.set(task.id, sourceRefs);
      referencedThreadIds.add(task.threadId);
    }
  }
  const ownerThreads = (await options.threads.list(auth.userId, [...referencedThreadIds])).filter(
    (thread) => !thread.deletedAt,
  );
  const ownerThreadById = new Map(ownerThreads.map((thread) => [thread.id, thread]));
  const taskSummaries = tasks.flatMap((task) => {
    const sourceRefs = taskSourceRefs.get(task.id);
    if (!sourceRefs) return [];
    const work = task.entrustedWork;
    if (work) return [{id: task.id, title: task.title, threadId: task.threadId, status: task.status,
      revision: work.revision, closure: work.closure.state, sourceRefs}];
    const thread = ownerThreadById.get(task.threadId);
    if (!task.ownerCatId || !thread?.participants.includes(task.ownerCatId)) return [];
    // These are the same UI fields used before migration. updatedAt is the
    // ordinary Task's observed version, not an execution/authorization revision.
    return [{id: task.id, title: task.title, threadId: task.threadId, status: task.status,
      revision: task.updatedAt, closure: task.status === 'done' ? 'satisfied' : 'open', sourceRefs}];
  });
  const requestItems = inbox.filter(
    (item) =>
      (item.event.recipient?.kind === 'agent' && item.event.recipient.connectionId === auth.connection.connectionId) ||
      item.event.attentionRequest === 'response_requested',
  );
  const recentRequestIds = new Set(requestItems.slice(-20).map((item) => item.event.eventId));
  const requests = await Promise.all(
    requestItems.map(async (item) => {
      const receipt = item.routeReceipt?.kind === 'thread_message' ? item.routeReceipt : undefined;
      const thread = receipt ? ownerThreadById.get(receipt.threadId) : undefined;
      const recipient = item.event.recipient;
      const response = [...(replies.get(item.event.eventId) ?? [])]
        .reverse()
        .find(
          (reply) =>
            recipient?.kind !== 'agent' ||
            (reply.actor.kind === 'agent' &&
              reply.actor.provenance.connectionId === recipient.connectionId &&
              reply.actor.provenance.catId === recipient.agentId),
        );
      const execution = recentRequestIds.has(item.event.eventId)
        ? await ownerRequestExecution(item, thread, options.messages, auth.userId, auth.connection.connectionId)
        : undefined;
      return {
        event: item.event,
        delivery: item.disposition,
        failure: item.routeFailure,
        messageId: receipt?.messageId,
        attention: receipt?.attention,
        response,
        ...(thread ? { privateThread: { id: thread.id, title: thread.title } } : {}),
        ...(execution ? { execution } : {}),
      };
    }),
  );
  return {
    connection: auth.connection,
    revision: auth.route?.revision ?? 0,
    cats: cats.map((cat) => {
      const profile = cat.configured ? profiles.get(cat.id) : undefined;
      return {
        id: cat.id,
        displayName: cat.displayName,
        configured: cat.configured,
        eligible: cat.eligible,
        supported: cat.eligible,
        ...(profile?.avatar ? { avatar: profile.avatar } : {}),
        ...(profile?.roleDescription ? { roleDescription: profile.roleDescription } : {}),
        ...(profile?.defaultModel ? { defaultModel: profile.defaultModel } : {}),
      };
    }),
    bindings: auth.route?.agentRoutes ?? {},
    desiredParticipation: preserveInitialExclusions(
      auth.route?.desiredParticipation ?? defaultDesiredParticipation(),
      auth.route,
      auth.connection.initialExcludedCatIds,
    ),
    observedEligibility: auth.route?.observedEligibility ?? {},
    channelRoutes: auth.route?.channelRoutes ?? {},
    standingInterests: auth.route?.standingInterests ?? {},
    attentionRevision: auth.route?.attentionRevision ?? 0,
    reconcileRequired:
      !auth.route ||
      hasUnavailableEndpoints(auth.route, ownerThreadById) ||
      cats.some((cat) => eligibilityChanged(auth.route, cat)),
    published,
    threads: ownerThreads.map((thread) => ({ id: thread.id, title: thread.title, participants: thread.participants })),
    requests,
    tasks: taskSummaries,
  };
}

function hasUnavailableEndpoints(
  route: HostRouteConfig,
  ownerThreads: ReadonlyMap<string, { readonly participants: readonly string[] }>,
) {
  if ([route.defaultIngressThreadId, route.humanNotificationThreadId].some((id) => !ownerThreads.has(id))) return true;
  return Object.values(route.channelRoutes ?? {}).some((endpoint) => {
    const thread = ownerThreads.get(endpoint.threadId);
    return (
      !thread ||
      Object.keys(endpoint.participants).some(
        (catId) => !thread.participants.some((participant) => participant === catId),
      )
    );
  });
}

function eligibilityChanged(
  route: HostRouteConfig | undefined,
  cat: { id: string; displayName: string; configured: boolean; eligible: boolean; profileFingerprint?: string },
) {
  const observed = route?.observedEligibility?.[cat.id];
  return (
    !observed ||
    observed.displayName !== cat.displayName ||
    observed.configured !== cat.configured ||
    observed.eligible !== cat.eligible ||
    observed.profileFingerprint !== cat.profileFingerprint
  );
}

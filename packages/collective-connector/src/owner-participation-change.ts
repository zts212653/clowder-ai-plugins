import { readCollectiveThread } from './collective-thread-snapshot.js';
import { z } from 'zod';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';
import type { CollectiveConnector } from './business/connector/connector.js';
import { registeredCollectiveCats } from './entry-control.js';

// Original ca5 individual PUT DTO; owner identity remains the Host webhook principal.
export const individualParticipationInput = z.object({
  catId: z.string().min(1).max(120), enabled: z.boolean(),
  expectedRevision: z.number().int().nonnegative(),
  channelIds: z.array(z.string().trim().min(1).max(160)).min(1).max(100),
  standingWork: z.object({
    requestingHumanIds: z.array(z.string().min(1).max(160)).min(1).max(100),
    threadId: z.string().min(1).max(240).optional(), expiresAt: z.string().datetime().nullable(),
  }).strict().optional(),
}).strict();

/** Original per-cat participation mutation, using existing owner roster/thread edges. */
export function createCollectiveOwnerParticipationChange(context: FeatureContext,
  connector: Pick<CollectiveConnector, 'getProjection' | 'getHostRoute' | 'setHostRoute' | 'publishParticipation'>,
  current: () => Promise<void>) {
  return async (userId: string, connectionId: string, input: z.infer<typeof individualParticipationInput>) => {
    await current();
    const connection = await connector.getProjection(connectionId);
    const route = await connector.getHostRoute(connectionId); await current();
    if (route && route.localOwnerUserId !== userId)
      throw Object.assign(new Error('Collective Host route belongs to another local owner'), { code: 'CONNECTOR_OWNER_MISMATCH' });
    if ((route?.revision ?? 0) !== input.expectedRevision)
      throw Object.assign(new Error('Collective participation changed'), { code: 'PARTICIPATION_REVISION_CONFLICT' });
    if (!context.members || !context.threads) throw new Error('Host owner participation ports unavailable');
    const rows = await context.members.list(); await current();
    const cats = registeredCollectiveCats(rows.map(({ catId, ...row }) => ({ ...row, id: catId })));
    const cat = cats.find(value => value.id === input.catId);
    if (!cat || (input.enabled && !cat.supported))
      throw Object.assign(new Error('Collective Cat participation is unsupported'), { code: 'PARTICIPATION_UNSUPPORTED' });
    if (!connection.authorizedHumanId || connection.authorityStatus !== 'connected')
      throw Object.assign(new Error('Collective participation authority is revoked'), { code: 'PARTICIPATION_REVOKED' });
    const threads = context.threads;
    const ownedThread = async (threadId?: string) => {
      await current();
      const thread = threadId ? await readCollectiveThread(threads, threadId) : await threads.create({ title: 'Collective 公共参与' });
      await current();
      // Existing strict ownerThreads.get returns null for deleted or foreign threads.
      if (!thread)
        throw Object.assign(new Error('Owner Thread is unavailable'), { code: 'ROUTE_THREAD_UNAVAILABLE' });
      if (!(await context.threads.getCats(thread.id)).participants.some(member => member.catId === cat.id)) { await threads.addParticipants({ threadId: thread.id, catIds: [cat.id] }); await current(); }
      return thread.id;
    };
    const key = `${connection.authorizedHumanId}:${cat.id}`;
    const existing = route?.agentRoutes[key];
    const threadId = existing?.threadId ?? await ownedThread();
    await ownedThread(threadId);
    const agentRoutes = { ...route?.agentRoutes };
    agentRoutes[key] = {
      catId: cat.id, threadId,
      ...(input.enabled ? { participation: { displayName: cat.displayName, channelIds: input.channelIds } } : {}),
      ...(input.enabled && input.standingWork ? { standingWork: { ...input.standingWork, channelIds: input.channelIds } } : {}),
    };
    await current();
    const updated = await connector.setHostRoute(connectionId, {
      localOwnerUserId: userId,
      defaultIngressThreadId: route?.defaultIngressThreadId ?? threadId,
      humanNotificationThreadId: route?.humanNotificationThreadId ?? threadId,
      agentRoutes,
    }, input.expectedRevision);
    await current(); await connector.publishParticipation(connectionId); await current();
    return updated;
  };
}

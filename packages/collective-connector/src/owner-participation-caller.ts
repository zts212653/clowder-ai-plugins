import { readCollectiveThread } from './collective-thread-snapshot.js';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';
import type { CollectiveConnector } from './business/connector/connector.js';
import { registeredCollectiveCats } from './entry-control.js';
import { collectiveOwnerParticipationView } from './owner-participation-view.js';
import type { OwnerViewThread } from './owner-participation-host-types.js';

/** Adapt the original owner view to existing Host read ports. No Task effects or synthetic queue truth. */
export function createCollectiveOwnerView(context: FeatureContext, connector: Pick<CollectiveConnector,
  'getProjection' | 'getHostRoute' | 'listInbox' | 'isParticipationPublished'>, current: () => Promise<void>) {
  return async (userId: string, connectionId: string) => {
    await current();
    const connection = await connector.getProjection(connectionId);
    const route = await connector.getHostRoute(connectionId); await current();
    if (route && route.localOwnerUserId !== userId)
      throw Object.assign(new Error('Collective Host route belongs to another local owner'), { code: 'CONNECTOR_OWNER_MISMATCH' });
    if (!context.members || !context.threads) throw new Error('Host owner view ports unavailable');
    const rows = await context.members.list(); await current();
    const cats = registeredCollectiveCats(rows.map(({ catId, ...row }) => ({ ...row, id: catId })));
    const body = await collectiveOwnerParticipationView({ cats: () => cats,
      storage: {async get(key) {await current();const value = await context.storage.get(key);await current();return value;}},
      threads: { async list(owner) {
        if (owner !== userId) throw new Error('Owner view principal changed');
        const owned: OwnerViewThread[] = [];
        let before: { readonly id: string; readonly lastActiveAt: number } | undefined;
        const seen = new Set<string>();
        while (true) {
          await current();
          const page = await context.threads.list({ limit: 50, ...(before ? { before } : {}) }); await current();
          for (const summary of page) {
            if (seen.has(summary.id)) throw new Error('Host owner thread traversal repeated a position');
            seen.add(summary.id);
            const thread = await readCollectiveThread(context.threads, summary.id); await current();
            if (thread) owned.push({ ...thread, title: summary.title });
          }
          if (page.length < 50) break;
          const last = page.at(-1)!;
          before = { id: last.id, lastActiveAt: last.lastActiveAt };
        }
        return owned;
      } },
      tasks: { async list(filter) {
        await current(); const tasks = await context.tasks.list(filter); await current();
        return tasks;
      } },
      messages: { async getById(id) {
        await current();
        const fact = await context.messaging.get(id); await current();
        return fact;
      } },
    }, { connector, connection, ...(route ? { route } : {}), userId });
    await current(); return body;
  };
}

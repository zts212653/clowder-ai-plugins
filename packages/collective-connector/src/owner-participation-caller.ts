import type { FeatureContext } from '@clowder-ai/plugin-sdk';
import type { CollectiveConnector } from './business/connector/connector.js';
import { registeredCollectiveCats } from './entry-control.js';
import { collectiveOwnerParticipationView } from './owner-participation-view.js';
import type { OwnerViewThread } from './owner-participation-host-types.js';
import { COLLECTIVE_NATIVE_ID } from './public-native-methods.js';

/** Adapt the original owner view to existing Host read ports. No Task effects or synthetic queue truth. */
export function createCollectiveOwnerView(context: FeatureContext, connector: Pick<CollectiveConnector,
  'getProjection' | 'getHostRoute' | 'listInbox' | 'isParticipationPublished'>, current: () => Promise<void>) {
  return async (userId: string, connectionId: string) => {
    await current();
    const connection = await connector.getProjection(connectionId);
    const route = await connector.getHostRoute(connectionId); await current();
    if (route && route.localOwnerUserId !== userId)
      throw Object.assign(new Error('Collective Host route belongs to another local owner'), { code: 'CONNECTOR_OWNER_MISMATCH' });
    if (!context.participantRoster || !context.ownerThreads) throw new Error('Host owner view ports unavailable');
    const rows = await context.participantRoster.listForNativeContribution({ contributionId: COLLECTIVE_NATIVE_ID }); await current();
    const support = new Map(rows.map(row => [row.catId, row.supported]));
    const cats = registeredCollectiveCats(rows.map(({ catId, supported: _supported, ...row }) => ({ ...row, id: catId })),
      id => support.get(id) === true);
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
            const thread = await context.ownerThreads!.get(summary.id); await current();
            if (thread?.createdBy === userId) owned.push({ ...thread, title: summary.title });
          }
          if (page.length < 50) break;
          const last = page.at(-1)!;
          before = { id: last.id, lastActiveAt: last.lastActiveAt };
        }
        return owned;
      } },
      tasks: { async listByKind(kind) {
        await current(); const tasks = await context.tasks.listByKind(kind); await current();
        return tasks;
      } },
      messages: { async getById(id) {
        await current();
        if (!context.sourceFacts?.readProgress) return undefined;
        const fact = await context.sourceFacts.readProgress({ messageRef: `message:${id}` }); await current();
        return fact;
      } },
    }, { connector, connection, ...(route ? { route } : {}), userId });
    await current(); return body;
  };
}

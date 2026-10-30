import { readCollectiveThread } from './collective-thread-snapshot.js';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';
import type { CollectiveConnector } from './business/connector/connector.js';
import { registeredCollectiveCats } from './entry-control.js';
import { collectiveOwnerParticipationView } from './owner-participation-view.js';
import type { OwnerViewThread } from './owner-participation-host-types.js';

type CandidateThreadList = (options: { readonly threadIds: readonly string[] }) =>
  ReturnType<FeatureContext['threads']['list']>;
type CandidateThreadHost = Pick<FeatureContext['threads'], 'get' | 'getCats'> & { readonly list: CandidateThreadList };

const OWNER_THREAD_CANDIDATE_BATCH_SIZE = 1_000;

export async function readCollectiveOwnerThreadCandidates(
  threads: CandidateThreadHost,
  threadIds: readonly string[],
  current: () => Promise<void>,
): Promise<readonly OwnerViewThread[]> {
  const owned: OwnerViewThread[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < threadIds.length; offset += OWNER_THREAD_CANDIDATE_BATCH_SIZE) {
    await current();
    const rows = await threads.list({ threadIds: threadIds.slice(offset, offset + OWNER_THREAD_CANDIDATE_BATCH_SIZE) });
    await current();
    for (const summary of rows) {
      if (seen.has(summary.id)) throw new Error('Host owner thread candidates repeated an id');
      seen.add(summary.id);
      const thread = await readCollectiveThread(threads, summary.id);
      await current();
      if (thread) owned.push({ ...thread, title: summary.title });
    }
  }
  return owned;
}

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
      threads: { async list(owner, threadIds) {
        if (owner !== userId) throw new Error('Owner view principal changed');
        // alpha.22 compiles against the last published SDK baseline. The same
        // source delta adds this type to the next SDK while Core supplies the
        // owner-filtered runtime capability before this caller is released.
        return readCollectiveOwnerThreadCandidates(context.threads as CandidateThreadHost, threadIds, current);
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

import type { CollectiveConnector } from './business/connector/connector.js';
import type { CollectiveProjectAttentionItem } from './business/contracts/types/collective-project-attention.js';

const coverage = 'pending_f290_project_materials_and_dates' as const;
export async function readCollectiveProjectAttentionSource(
  connector: CollectiveConnector,
  ownerUserId: string,
  assertCurrent: () => Promise<void>,
) {
  const startedAt = Date.now(),
    items = new Map<string, CollectiveProjectAttentionItem>(),
    reasons: string[] = [];
  await assertCurrent();
  let connections: Awaited<ReturnType<CollectiveConnector['listConnections']>>;
  try {
    connections = await connector.listConnections();
  } catch {
    await assertCurrent();
    return {
      items: [],
      reasons: ['collective_project_attention_source_unavailable'],
      state: {
        coverage,
        startedAt,
        observedAt: Date.now(),
        status: 'unavailable' as const,
        exhaustiveness: 'unknown' as const,
      },
    };
  }
  for (const connection of connections) {
    try {
      const route = await connector.getHostRoute(connection.connectionId);
      await assertCurrent();
      if (route?.localOwnerUserId !== ownerUserId || connection.authorityStatus !== 'connected') continue;
      const read = await connector.readProjectAttention(connection.connectionId, ownerUserId);
      await assertCurrent();
      reasons.push(...read.reasons);
      for (const item of read.items) {
        const previous = items.get(item.subjectRef);
        if (!previous || item.expectedProducerRevision > previous.expectedProducerRevision)
          items.set(item.subjectRef, item);
      }
    } catch {
      await assertCurrent();
      reasons.push('collective_project_attention_source_unavailable');
    }
  }
  await assertCurrent();
  return {
    items: [...items.values()],
    reasons: [...new Set(reasons)],
    state: {
      coverage,
      startedAt,
      observedAt: Date.now(),
      status: 'available' as const,
      exhaustiveness: reasons.length ? ('partial' as const) : ('complete' as const),
    },
  };
}

import { memoryRecallPersistRequest } from '@clowder-ai/plugin-memory-contract/recall';
import type { MemoryHostPorts } from '../host-port.js';
import type { openMemoryStorage } from '../open-memory-storage.js';

export async function dispatchRecallPersist(
  storage: Awaited<ReturnType<typeof openMemoryStorage>>,
  source: MemoryHostPorts['memorySource'],
  request: unknown,
) {
  const { input } = memoryRecallPersistRequest.parse(request);
  const { threadId, invocationId } = await source.caller();
  if (input.events.some((event) => event.threadId !== threadId || event.invocationId !== invocationId)) {
    throw new Error('memory_recall_scope_mismatch');
  }
  return storage.runWrite(async () => {
    await source.assertCurrent();
    const stmt = storage.db.prepare(`
      INSERT OR IGNORE INTO recall_events
        (recall_id, cat_id, invocation_id, tool_name, query, mode, scope,
         candidates_json, result_count, result_status, consumed_json, reformulated, fell_back_to_grep,
         abandoned, next_graph_resolve_after_read, token_cost, timestamp,
         shadow_ranking_json, result_set_id, attribution_clarity, thread_id,
         source, push_surface, presented, inspected, outcome, source_event_id,
         expansion_funnel_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    storage.db.transaction(() => {
      for (const event of input.events) {
        stmt.run(
          event.recallId,
          event.catId,
          event.invocationId,
          event.toolName,
          event.query,
          event.mode ?? null,
          event.scope ?? null,
          JSON.stringify(event.candidates),
          event.resultCount ?? null,
          event.resultStatus ?? null,
          JSON.stringify(event.consumed),
          Number(event.reformulated),
          Number(event.fellBackToGrep),
          Number(event.abandoned),
          Number(event.nextGraphResolveAfterRead),
          event.tokenCost,
          event.timestamp,
          event.shadowRankingJson ?? null,
          event.resultSetId ?? null,
          event.attributionClarity ?? null,
          event.threadId,
          event.source,
          event.pushSurface ?? null,
          Number(event.presented),
          Number(event.inspected),
          event.outcome,
          event.sourceEventId ?? null,
          event.expansionFunnel ? JSON.stringify(event.expansionFunnel) : null,
        );
      }
    })();
    return null;
  });
}

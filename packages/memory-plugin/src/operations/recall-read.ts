import {
  type MemoryRecallEvent,
  memoryRecallEventRequest,
  memoryRecallStatsRequest,
  type MemoryRecallStatsResult,
  memoryRecallTimelineRequest,
  type MemoryRecallTimelineResult,
} from '@clowder-ai/plugin-memory-contract/recall';
import type Database from 'better-sqlite3';
import type { MemoryHostPorts } from '../host-port.js';

export function dispatchRecallStats(db: Database.Database, request: unknown): MemoryRecallStatsResult {
  const { input } = memoryRecallStatsRequest.parse(request);
  return db.prepare<{ threads: string; from: number; to: number }, MemoryRecallStatsResult[number]>(`
    SELECT source, COALESCE(push_surface, tool_name) AS surface,
           COUNT(*) AS presented, SUM(inspected) AS inspected,
           SUM(CASE WHEN outcome = 'used' THEN 1 ELSE 0 END) AS used
    FROM recall_events
    WHERE timestamp BETWEEN @from AND @to
      AND thread_id IN (SELECT value FROM json_each(@threads))
    GROUP BY source, COALESCE(push_surface, tool_name) ORDER BY source DESC, presented DESC
  `).all({ threads: JSON.stringify(input.threadIds), from: input.from, to: input.to });
}

export async function dispatchRecallTimeline(db: Database.Database, source: MemoryHostPorts['memorySource'], request: unknown) {
  const { input } = memoryRecallTimelineRequest.parse(request);
  const { userId: owner } = await source.caller();
  await source.assertCurrent();
  return db.prepare<{
    threads: string;
    owner: string;
    source: string;
    cat: string;
    from: number;
    to: number;
    at: number | null;
    key: string;
    limit: number;
  }, MemoryRecallTimelineResult[number]>(`
    WITH visible AS (SELECT value AS id FROM json_each(@threads)), timeline AS (
      SELECT 'recall:' || recall_id AS key, timestamp AS at, thread_id, invocation_id, NULL AS cue_id, recall_id
      FROM recall_events WHERE thread_id IN (SELECT id FROM visible) AND timestamp BETWEEN @from AND @to
        AND (@source = 'all' OR source = @source) AND (@cat = '' OR cat_id = @cat)
      UNION ALL
      SELECT json_array('cue', thread_id, invocation_id, cue_id) AS key, MIN(occurred_at) AS at,
        thread_id, invocation_id, cue_id, NULL AS recall_id
      FROM memory_cue_events WHERE owner_user_id = @owner AND thread_id IN (SELECT id FROM visible)
        AND axis = 'consumption' AND consumption_outcome = 'presented'
        AND (@source = 'all' OR @source = CASE WHEN read_origin = 'explicit_read' THEN 'pull' ELSE 'push' END)
        AND (@cat = '' OR consumer_cat_id = @cat)
      GROUP BY thread_id, invocation_id, cue_id HAVING at BETWEEN @from AND @to
    ) SELECT * FROM timeline WHERE (@at IS NULL OR at < @at OR (at = @at AND key < @key))
      ORDER BY at DESC, key DESC LIMIT @limit
  `).all({
    threads: JSON.stringify(input.threadIds),
    owner,
    source: input.source,
    cat: input.catId ?? '',
    from: input.from,
    to: input.to,
    at: input.before?.at ?? null,
    key: input.before?.key ?? '',
    limit: input.limit + 1,
  });
}

export function dispatchRecallEvent(db: Database.Database, request: unknown) {
  const { input } = memoryRecallEventRequest.parse(request);
  return db.prepare<[string, string], MemoryRecallEvent>(`
    SELECT recall_id, cat_id, invocation_id, source_event_id, tool_name, query, mode, scope,
      candidates_json, consumed_json, result_count, result_status, timestamp, source, push_surface, inspected
    FROM recall_events WHERE recall_id = ? AND thread_id = ?
  `).get(input.recallId, input.threadId) ?? null;
}

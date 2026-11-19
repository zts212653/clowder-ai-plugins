import { memoryRecallStatsRequest, type MemoryRecallStatsResult } from '@clowder-ai/plugin-memory-contract/recall';
import type Database from 'better-sqlite3';

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

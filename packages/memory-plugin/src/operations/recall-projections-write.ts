import { randomUUID } from 'node:crypto';
import type { MemoryRecallPersistRequest } from '@clowder-ai/plugin-memory-contract/recall';
import type Database from 'better-sqlite3';

type RecallBatch = MemoryRecallPersistRequest['input'];
type RecallRecord = RecallBatch['events'][number];
const operationalStatuses = new Set(['error', 'timeout', 'cancelled', 'overflow']);

function unmetDemandBucket(event: RecallRecord) {
  if (event.candidates.length || (event.resultCount ?? 0) > 0) return null;
  const status = event.resultStatus;
  if (status === 'no_results' && event.resultCount === 0) return 'true_zero';
  if (status === 'parser_miss') return 'parser_miss';
  if (status === 'legacy_unknown' || status === 'result_unmerged') return 'not_written';
  if (status && operationalStatuses.has(status)) return null;
  return event.resultCount === undefined ? 'null_count' : null;
}

export function persistRecallProjections(db: Database.Database, events: RecallRecord[], input: RecallBatch) {
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const trace = db.prepare(`
    INSERT OR IGNORE INTO lifecycle_traces (
      trace_id, kind, category, source_family, recall_id, source_event_id, thread_id, target_anchor,
      query_text, claim_kind, check_source, verdict, payload_json, observed_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const event of events) {
    const category = unmetDemandBucket(event);
    if (!category) continue;
    trace.run(
      randomUUID(), 'unmet_demand', category, event.toolName, event.recallId, event.sourceEventId ?? null,
      event.threadId, null, event.query || null, null, null, null,
      JSON.stringify({
        toolName: event.toolName, mode: event.mode ?? null, scope: event.scope ?? null,
        resultStatus: event.resultStatus ?? null, resultCount: event.resultCount ?? null,
      }),
      event.timestamp, createdAt,
    );
    if (category === 'true_zero') {
      trace.run(
        randomUUID(), 'verification', null, event.toolName, event.recallId, event.sourceEventId ?? null,
        event.threadId, event.query ? `query:${event.query.slice(0, 200)}` : `tool:${event.toolName}`,
        null, 'unmet-demand', 'recall-correlation-zero-hit', 'confirmed',
        JSON.stringify({ toolName: event.toolName, query: event.query, resultStatus: event.resultStatus }),
        event.timestamp, createdAt,
      );
    }
  }

  if (input.trajectory) {
    const { invocationId, threadId, catId } = events[0]!;
    const rows = db.prepare<[string, string, string], { recall_id: string; query: string; token_cost: number }>(`
      SELECT recall_id, query, token_cost FROM recall_events
      WHERE invocation_id = ? AND thread_id = ? AND cat_id = ? ORDER BY timestamp ASC
    `).all(invocationId, threadId, catId);
    const queries = [...new Set(rows.map((row) => row.query).filter(Boolean))];
    db.prepare(`
      INSERT INTO task_trajectories (
        trajectory_id, invocation_id, thread_id, cat_id, task_context, search_event_ids_json, files_read_json,
        files_modified_json, output_verified, output_verified_signals_json, total_token_cost, duration, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', ?, ?, ?, ?)
    `).run(
      randomUUID(), invocationId, threadId, catId, queries.length ? queries.join(' → ') : null,
      JSON.stringify(rows.map((row) => row.recall_id)), JSON.stringify(input.trajectory.filesRead),
      JSON.stringify(input.trajectory.filesModified), rows.reduce((sum, row) => sum + (row.token_cost || 0), 0),
      input.trajectory.duration, now, now,
    );
  }

  if (!input.traversals?.length) return;
  const consumed = new Set(events.flatMap((event) => event.consumed.map((entry) => entry.anchor)));
  const traverse = db.prepare(`
    UPDATE edges SET traversal_count = COALESCE(traversal_count, 0) + 1, last_traversed_at = ?
    WHERE from_anchor = ? AND to_anchor = ? AND relation = ?
  `);
  for (const edge of input.traversals) {
    if (consumed.has(edge.to)) traverse.run(createdAt, edge.from, edge.to, edge.relation);
  }
}


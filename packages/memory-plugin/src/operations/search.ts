import type { SearchHitDto, SearchInput, SearchResultDto } from '@clowder-ai/plugin-memory-contract';

import type { MemoryDatabasePort } from '../host-port.js';
import { type SearchFilters, openEvidenceDatabase, type EvidenceDatabase } from './evidence-database.js';
import { buildProgressiveFtsQueries, splitLexicalBackfillWords } from './fts.js';

/** Rows a lexical pass may consider before the plugin applies the caller's limit. */
const CANDIDATE_POOL = 100;

/** A record whose status or supersession moves it behind current results. */
const DEMOTED_STATUSES = new Set(['superseded', 'drifted', 'stale', 'historical', 'retired', 'invalidated']);

interface DocRow {
  anchor: string;
  kind: string;
  status: string;
  title: string;
  summary: string | null;
  source_path: string | null;
  source_hash: string | null;
  updated_at: string;
  authority: string | null;
  superseded_by: string | null;
  bm25: number | null;
}

function isDemoted(row: DocRow): boolean {
  return row.authority !== 'constitutional' && (row.superseded_by !== null || DEMOTED_STATUSES.has(row.status));
}

function toHit(row: DocRow, index: number): SearchHitDto {
  return {
    anchor: row.anchor,
    kind: row.kind,
    title: row.title,
    snippet: row.summary ?? '',
    rank: index + 1,
    status: row.status,
    updatedAt: row.updated_at,
    ...(row.source_path === null ? {} : { sourcePath: row.source_path }),
    ...(row.source_hash === null ? {} : { sourceHash: row.source_hash }),
    ...(row.authority === null ? {} : { authority: row.authority }),
  };
}

/**
 * Resolve the caller's scope exactly as the Host's own store resolves it.
 *
 * `scope` narrows kinds; a thread is an exact anchor, so it is a result
 * boundary rather than a ranking hint — an unfiltered provider could only
 * produce an authoritative empty result, never a cross-thread leak.
 */
export function searchFilters(options: SearchInput['options']): SearchFilters {
  return {
    kind: options.scope === 'threads' ? 'thread' : options.scope === 'sessions' ? 'session' : undefined,
    excludeSessionAndThread: options.scope === 'docs' || options.scope === 'memory',
    threadAnchor: options.threadId === undefined ? undefined : `thread-${options.threadId}`,
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
  };
}

/**
 * Evidence retrieval over the Host-resolved database.
 *
 * Retrieval here is lexical only. Semantic and hybrid ranking need the Host's
 * embedding pipeline, which this plugin does not own yet; asking for either
 * degrades to lexical and says so, because a caller that believes it received
 * semantic ranking reads the result differently.
 */
export class SearchOperations {
  constructor(private readonly database: MemoryDatabasePort) {}

  async query(input: SearchInput): Promise<SearchResultDto> {
    const requestedMode = input.options.mode ?? 'lexical';
    const degraded = requestedMode !== 'lexical';
    const limit = input.options.limit ?? 5;
    const filters = searchFilters(input.options);
    const db = openEvidenceDatabase(this.database);
    try {
      const rows = this.#rank(db, input.query.trim(), filters, limit);
      return {
        query: input.query,
        hits: rows.map(toHit),
        degraded,
        ...(degraded ? { degradeReason: 'raw_lexical_only', effectiveMode: 'lexical' as const } : {}),
      };
    } finally {
      db.close();
    }
  }

  #rank(db: EvidenceDatabase, query: string, filters: SearchFilters, limit: number): DocRow[] {
    const seen = new Set<string>();
    const rows: DocRow[] = [];
    const collect = (batch: DocRow[]) => {
      for (const row of batch) {
        if (seen.has(row.anchor)) continue;
        seen.add(row.anchor);
        rows.push(row);
      }
    };

    // Exact anchor first: FTS5 unicode61 splits identifiers like "F042", so an
    // anchor-shaped query would otherwise lose the precision the caller asked for.
    collect(db.exactAnchor(query, filters));

    // Progressive relaxation stops at the first level that finds anything: a
    // looser pass only runs when the tighter one came back empty.
    for (const ftsQuery of buildProgressiveFtsQueries(query)) {
      const batch = db.fts(ftsQuery, filters, CANDIDATE_POOL);
      if (batch.length === 0) continue;
      collect(batch);
      break;
    }

    // Substring backfill recovers hits that unicode61 tokenization misses.
    if (rows.length === 0) {
      const words = splitLexicalBackfillWords(query);
      if (words.length > 0) collect(db.lexicalBackfill(words, filters, CANDIDATE_POOL));
    }

    // Superseded and drifted records sink behind current ones, matching how the
    // Host's own store orders the same rows.
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => Number(isDemoted(a.row)) - Number(isDemoted(b.row)) || a.index - b.index)
      .map(({ row }) => row)
      .slice(0, limit);
  }
}

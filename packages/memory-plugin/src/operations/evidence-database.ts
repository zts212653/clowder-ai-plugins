import { DatabaseSync, type SqlValue } from 'node:sqlite';

import type { MemoryDatabasePort } from '../host-port.js';

/** Filters every retrieval pass applies; resolved once from the caller's scope. */
export interface SearchFilters {
  readonly kind: string | undefined;
  readonly excludeSessionAndThread: boolean;
  readonly threadAnchor: string | undefined;
  readonly dateFrom: string | undefined;
  readonly dateTo: string | undefined;
}

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

/** Columns the retrieval shape needs; storage bookkeeping stays in the database. */
const COLUMNS = `d.anchor, d.kind, d.status, d.title, d.summary, d.source_path,
  d.source_hash, d.updated_at, d.authority, d.superseded_by`;

/** The shared document filters, applied identically to every pass. */
function whereClause(filters: SearchFilters, params: SqlValue[]): string {
  let sql = '';
  if (filters.kind !== undefined) {
    sql += ' AND d.kind = ?';
    params.push(filters.kind);
  }
  if (filters.excludeSessionAndThread) sql += " AND d.kind != 'session' AND d.kind != 'thread'";
  if (filters.threadAnchor !== undefined) {
    sql += ' AND d.anchor = ?';
    params.push(filters.threadAnchor);
  }
  if (filters.dateFrom !== undefined) {
    sql += ' AND d.updated_at >= ?';
    params.push(filters.dateFrom);
  }
  if (filters.dateTo !== undefined) {
    sql += ' AND d.updated_at <= ?';
    params.push(filters.dateTo.length === 10 ? `${filters.dateTo}T23:59:59` : filters.dateTo);
  }
  // Backstop documents exist to be injected into a prompt, never returned as a
  // search hit. Pull-only rows are deliberately visible to pull surfaces such as
  // this one, which is why they are not excluded.
  return `${sql} AND d.activation != 'backstop'`;
}

/**
 * Read-only access to the Host-resolved evidence database.
 *
 * The plugin opens its own handle because it runs in a worker thread and cannot
 * be handed a connection. It never creates or migrates the schema: the Host owns
 * that, and a plugin that silently created an empty table would turn "no
 * database" into "no results", which reads identically to a real miss.
 */
export interface EvidenceDatabase {
  exactAnchor(query: string, filters: SearchFilters): DocRow[];
  fts(ftsQuery: string, filters: SearchFilters, limit: number): DocRow[];
  lexicalBackfill(words: readonly string[], filters: SearchFilters, limit: number): DocRow[];
  close(): void;
}

export function openEvidenceDatabase(port: MemoryDatabasePort): EvidenceDatabase {
  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(port.canonicalPath, { readOnly: true });
    // Fail loudly if the Host's schema is not there, instead of answering "no hits":
    // an empty answer and a missing database are indistinguishable to a caller.
    db.prepare('SELECT anchor FROM evidence_docs LIMIT 1').get();
  } catch (error) {
    throw new Error(
      `memory plugin cannot read the evidence database at ${port.canonicalPath}: ${(error as Error).message}`,
      { cause: error },
    );
  }
  // The driver types every row as a loose record; the projections above select
  // exactly these columns from the Host's own schema, so this is the one place
  // that conversion happens.
  const rows = (sql: string, params: SqlValue[]): DocRow[] => db.prepare(sql).all(...params) as unknown as DocRow[];
  return {
    exactAnchor(query, filters) {
      const params: SqlValue[] = [query];
      const sql = `SELECT ${COLUMNS}, NULL AS bm25 FROM evidence_docs d
        WHERE d.anchor = ? COLLATE NOCASE${whereClause(filters, params)} LIMIT 1`;
      return rows(sql, params);
    },
    fts(ftsQuery, filters, limit) {
      const params: SqlValue[] = [ftsQuery];
      const sql = `SELECT ${COLUMNS}, bm25(evidence_fts, 5.0, 1.0, 2.0) AS bm25
        FROM evidence_fts f JOIN evidence_docs d ON d.rowid = f.rowid
        WHERE evidence_fts MATCH ?${whereClause(filters, params)}
        ORDER BY bm25 LIMIT ?`;
      params.push(limit);
      return rows(sql, params);
    },
    lexicalBackfill(words, filters, limit) {
      const conditions = words.map(
        () => "(LOWER(d.title) LIKE ? OR LOWER(COALESCE(d.summary, '')) LIKE ? OR LOWER(COALESCE(d.keywords, '')) LIKE ?)",
      );
      const params: SqlValue[] = words.flatMap((word) => {
        const needle = `%${word.toLowerCase()}%`;
        return [needle, needle, needle];
      });
      const sql = `SELECT ${COLUMNS}, NULL AS bm25 FROM evidence_docs d
        WHERE (${conditions.join(' OR ')})${whereClause(filters, params)} LIMIT ?`;
      params.push(limit);
      return rows(sql, params);
    },
    close() {
      db.close();
    },
  };
}

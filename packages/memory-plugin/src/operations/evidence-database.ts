/** A value the shared connection accepts as a bound parameter. */
type SqlValue = string | number | bigint | null | Uint8Array;

/** Filters every retrieval pass applies; resolved once from the caller's scope. */
export interface SearchFilters {
  readonly kind: string | undefined;
  readonly excludeSessionAndThread: boolean;
  readonly threadAnchor: string | undefined;
  readonly dateFrom: string | undefined;
  readonly dateTo: string | undefined;
  /** Whether rows reserved for pull surfaces are admitted. */
  readonly includePullOnly: boolean;
}

export interface DocRow {
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

/** One stored passage of a document. */
export interface PassageRow {
  doc_anchor: string;
  passage_id: string;
  content: string;
  speaker: string | null;
  position: number | null;
  created_at: string | null;
}

/** Columns the retrieval shape needs; storage bookkeeping stays in the database. */
const COLUMNS = `d.anchor, d.kind, d.status, d.title, d.summary, d.source_path,
  d.source_hash, d.updated_at, d.authority, d.superseded_by`;

const PASSAGE_COLUMNS = `p.doc_anchor, p.passage_id, p.content, p.speaker, p.position, p.created_at`;

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
  // search hit. Pull-only rows are the opposite: they must not reach ordinary
  // recall, and they are admitted only when the caller established that it is
  // pulling.
  if (!filters.includePullOnly) sql += " AND COALESCE(d.activation, 'query') != 'pull_only'";
  return sql + " AND COALESCE(d.activation, 'query') != 'backstop'";
}

/**
 * The same boundaries for a passage, resolved through its document.
 *
 * Passage search does not read `evidence_docs` itself, so the scope, thread and
 * time boundaries have to be expressed as a membership test: a passage whose
 * document the caller may not see is not a passage the caller may see.
 */
function passageScopeClause(filters: SearchFilters, params: SqlValue[]): string {
  return ` AND p.doc_anchor IN (SELECT d.anchor FROM evidence_docs d WHERE 1 = 1${whereClause(filters, params)})`;
}

/**
 * Passage boundaries that live on the passage itself rather than its document.
 *
 * Thread and time narrow what a passage match may be, so they are checked here
 * and not only through the document; the document membership test above still
 * runs, because a visible passage of an invisible document is still a leak.
 */
function passageClause(filters: SearchFilters, params: SqlValue[], alias: string): string {
  let sql = '';
  if (filters.threadAnchor !== undefined) {
    sql += ` AND ${alias}.doc_anchor = ?`;
    params.push(filters.threadAnchor);
  }
  if (filters.dateFrom !== undefined) {
    sql += ` AND ${alias}.created_at >= ?`;
    params.push(filters.dateFrom);
  }
  if (filters.dateTo !== undefined) {
    sql += ` AND ${alias}.created_at <= ?`;
    params.push(filters.dateTo.length === 10 ? `${filters.dateTo}T23:59:59` : filters.dateTo);
  }
  return sql;
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
  /** Documents by anchor, in the caller's order, keeping only rows the filters admit. */
  byAnchors(anchors: readonly string[], filters: SearchFilters): DocRow[];
  /** Passages whose text matches, in BM25 order, narrowed by thread and time. */
  ftsPassages(ftsQuery: string, filters: SearchFilters, limit: number): PassageRow[];
  /** Passages by their document and passage id, in the caller's order. */
  passagesByKeys(keys: ReadonlyArray<{ docAnchor: string; passageId: string }>, filters: SearchFilters): PassageRow[];
  /** Passages around one position of a document, inside the caller's boundaries. */
  passagesAround(docAnchor: string, position: number, radius: number, filters: SearchFilters): PassageRow[];
}

/**
 * The subset of the shared connection this reader uses.
 *
 * Deliberately loose: better-sqlite3 (the activation's connection) and
 * node:sqlite (the standalone test fixture) both satisfy it, and the single
 * conversion to a row shape happens below in `rows`.
 */
export interface EvidenceConnection {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
}

/**
 * Build the reader over the activation's shared evidence connection.
 *
 * Retrieval does not open its own handle. One activation owns exactly one
 * connection and one write queue (`openMemoryStorage`); a second connection
 * would be a second writer against the same file, and the queue that serializes
 * evidence writes would no longer cover every writer it is meant to.
 */
export function createEvidenceReader(db: EvidenceConnection): EvidenceDatabase {
  // The driver types every row as a loose record; the projections above select
  // exactly these columns from the Host's own schema, so this is the one place
  // that conversion happens.
  const rows = (sql: string, params: SqlValue[]): DocRow[] => db.prepare(sql).all(...params) as DocRow[];
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
    byAnchors(anchors, filters) {
      if (anchors.length === 0) return [];
      // The vector index returns anchors by distance; the caller's order is the
      // ranking, so the SQL must not reorder them.
      const params: SqlValue[] = [...anchors];
      const sql = `SELECT ${COLUMNS}, NULL AS bm25 FROM evidence_docs d
        WHERE d.anchor IN (${anchors.map(() => '?').join(',')})${whereClause(filters, params)}`;
      const byAnchor = new Map(rows(sql, params).map((row) => [row.anchor, row]));
      return anchors.flatMap((anchor) => {
        const row = byAnchor.get(anchor);
        return row === undefined ? [] : [row];
      });
    },
    ftsPassages(ftsQuery, filters, limit) {
      const params: SqlValue[] = [ftsQuery];
      const sql = `SELECT ${PASSAGE_COLUMNS} FROM passage_fts f
        JOIN evidence_passages p ON p.rowid = f.rowid
        WHERE passage_fts MATCH ?${passageScopeClause(filters, params)}${passageClause(filters, params, 'p')}
        ORDER BY f.rank LIMIT ?`;
      return db.prepare(sql).all(...params, limit) as PassageRow[];
    },
    passagesByKeys(keys, filters) {
      if (keys.length === 0) return [];
      const coordinates = keys.map(() => '(?, ?)').join(', ');
      const params: SqlValue[] = keys.flatMap((key) => [key.docAnchor, key.passageId]);
      const sql = `WITH passage_hits(doc_anchor, passage_id) AS (VALUES ${coordinates})
        SELECT ${PASSAGE_COLUMNS} FROM passage_hits h
        JOIN evidence_passages p ON p.doc_anchor = h.doc_anchor AND p.passage_id = h.passage_id
        WHERE 1 = 1${passageScopeClause(filters, params)}${passageClause(filters, params, 'p')}`;
      const found = new Map(
        (db.prepare(sql).all(...params) as PassageRow[]).map((row) => [
          `${row.doc_anchor}\u001f${row.passage_id}`,
          row,
        ]),
      );
      return keys.flatMap((key) => {
        const row = found.get(`${key.docAnchor}\u001f${key.passageId}`);
        return row === undefined ? [] : [row];
      });
    },
    passagesAround(docAnchor, position, radius, filters) {
      const params: SqlValue[] = [docAnchor, position - radius, position + radius];
      return db
        .prepare(
          `SELECT ${PASSAGE_COLUMNS} FROM evidence_passages p
           WHERE p.doc_anchor = ? AND p.position BETWEEN ? AND ?
           ${passageScopeClause(filters, params)}${passageClause(filters, params, 'p')} ORDER BY p.position, p.passage_id`,
        )
        .all(...params) as PassageRow[];
    },
  };
}

import type { SearchHitDto, SearchInput, SearchPassageDto, SearchResultDto } from '@clowder-ai/plugin-memory-contract';

import type { MemoryEmbeddingPort, MemoryQueryVector } from '../host-port.js';
import {
  createEvidenceReader,
  type DocRow,
  type EvidenceConnection,
  type EvidenceDatabase,
  type PassageRow,
  type SearchFilters,
} from './evidence-database.js';
import { buildProgressiveFtsQueries, splitLexicalBackfillWords } from './fts.js';
import {
  fuseByReciprocalRank,
  generationStillCurrent,
  nearestDocuments,
  nearestPassages,
  parsePassageVectorKey,
  readGenerationEpoch,
  vectorIdentityMatches,
} from './vectors.js';

/** Rows a ranked pass may consider before the plugin applies the caller's limit. */
const CANDIDATE_POOL = 100;

/** A record whose status or supersession moves it behind current results. */
const DEMOTED_STATUSES = new Set(['superseded', 'drifted', 'stale', 'historical', 'retired', 'invalidated']);

function isDemoted(row: DocRow): boolean {
  return row.authority !== 'constitutional' && (row.superseded_by !== null || DEMOTED_STATUSES.has(row.status));
}

function passageKeyOf(docAnchor: string, passageId: string): string {
  return JSON.stringify([docAnchor, passageId]);
}

/**
 * The Host's own passage identity rules: a thread document's anchor carries the
 * thread id, a message's passage id carries the message id.
 */
function toPassage(row: PassageRow): SearchPassageDto {
  const threadId = row.doc_anchor.startsWith('thread-') ? row.doc_anchor.slice('thread-'.length) : undefined;
  const messageId = row.passage_id.startsWith('msg-') ? row.passage_id.slice('msg-'.length) : undefined;
  return {
    docAnchor: row.doc_anchor,
    passageId: row.passage_id,
    content: row.content,
    ...(row.speaker === null ? {} : { speaker: row.speaker }),
    ...(row.created_at === null ? {} : { createdAt: row.created_at }),
    ...(threadId === undefined || threadId === '' ? {} : { threadId }),
    ...(messageId === undefined || messageId === '' ? {} : { messageId }),
  };
}

function toHit(
  row: DocRow,
  index: number,
  summary: string | undefined,
  passages: readonly SearchPassageDto[] | undefined,
): SearchHitDto {
  return {
    anchor: row.anchor,
    kind: row.kind,
    title: row.title,
    snippet: summary ?? row.summary ?? '',
    rank: index + 1,
    status: row.status,
    updatedAt: row.updated_at,
    ...(row.source_path === null ? {} : { sourcePath: row.source_path }),
    ...(row.source_hash === null ? {} : { sourceHash: row.source_hash }),
    ...(row.authority === null ? {} : { authority: row.authority }),
    // Absent, never empty: an empty array would claim the document has no
    // passages, which is a different fact from "this was not a raw request".
    ...(passages === undefined ? {} : { passages }),
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
    includePullOnly: options.includePullOnly === true,
  };
}

/** What one query actually executed, so the caller is told the truth about it. */
interface Executed {
  readonly rows: DocRow[];
  readonly degraded: boolean;
  readonly degradeReason?: string;
  readonly effectiveMode: 'lexical' | 'semantic' | 'hybrid';
}

/** The caller's own view of a query: what to rank, in which mode, inside which boundaries. */
interface Request {
  readonly query: string;
  readonly mode: 'lexical' | 'semantic' | 'hybrid';
  readonly filters: SearchFilters;
  readonly limit: number;
}

/**
 * What a raw query produced: documents ranked by their best passage, with the
 * passages that earned each of them.
 */
interface RawExecuted {
  readonly documents: DocRow[];
  readonly summaries: Map<string, string>;
  readonly passages: Map<string, SearchPassageDto[]>;
  readonly degraded: boolean;
  readonly degradeReason?: string;
  readonly effectiveMode: 'lexical' | 'semantic' | 'hybrid';
}

/**
 * Evidence retrieval over the activation's shared evidence connection.
 *
 * All three modes run here. Lexical is BM25 over `evidence_fts`; semantic reads
 * the Host's own vec0 index for query-vector neighbours; hybrid fuses the two by
 * reciprocal rank, exactly as the Host fuses them. `depth: 'raw'` ranks passages
 * rather than documents, again as the Host does, and hands each hit the passages
 * that matched it.
 *
 * Everything runs on the one connection the activation opened, handed in rather
 * than reopened: a second handle would be a second writer outside the queue that
 * exists to serialize evidence writes.
 */
export class SearchOperations {
  readonly #reader: EvidenceDatabase;
  readonly #vectors: EvidenceConnection;
  readonly #embedding: MemoryEmbeddingPort | undefined;

  constructor(db: EvidenceConnection, embedding: MemoryEmbeddingPort | undefined) {
    this.#reader = createEvidenceReader(db);
    this.#vectors = db;
    this.#embedding = embedding;
  }

  async query(input: SearchInput): Promise<SearchResultDto> {
    const request: Request = {
      query: input.query.trim(),
      mode: input.options.mode ?? 'lexical',
      filters: searchFilters(input.options),
      limit: input.options.limit ?? 5,
    };
    const executed = input.options.depth === 'raw' ? await this.#raw(request, input.options.contextWindow) : null;
    if (executed !== null) {
      return {
        query: input.query,
        hits: executed.documents.map((row, index) =>
          toHit(row, index, executed.summaries.get(row.anchor), executed.passages.get(row.anchor) ?? []),
        ),
        degraded: executed.degraded,
        ...(executed.degradeReason === undefined ? {} : { degradeReason: executed.degradeReason }),
        ...(executed.effectiveMode === request.mode ? {} : { effectiveMode: executed.effectiveMode }),
      };
    }
    const summary = await this.#summary(request);
    return {
      query: input.query,
      hits: summary.rows.map((row, index) => toHit(row, index, undefined, undefined)),
      degraded: summary.degraded,
      ...(summary.degradeReason === undefined ? {} : { degradeReason: summary.degradeReason }),
      ...(summary.effectiveMode === request.mode ? {} : { effectiveMode: summary.effectiveMode }),
    };
  }

  // ── Summary depth: documents ──────────────────────────────────────

  async #summary(request: Request): Promise<Executed> {
    const lexical = this.#lexical(request.query, request.filters, request.limit);
    if (request.mode === 'lexical') return { rows: lexical, degraded: false, effectiveMode: 'lexical' };

    const vector = await this.#queryVector(request.query);
    if (vector === null) return this.#degrade(lexical, 'passage_embedding_unavailable');
    // Nothing about a mismatched generation announces itself in the distances.
    if (!vectorIdentityMatches(this.#vectors, vector)) return this.#degrade(lexical, 'passage_vector_search_error');
    const epoch = readGenerationEpoch(this.#vectors, vector);

    let neighbours: Array<{ anchor: string; distance: number }>;
    try {
      neighbours =
        request.mode === 'semantic'
          ? this.#semanticAnchors(vector, request.filters, request.limit)
          : nearestDocuments(this.#vectors, vector, CANDIDATE_POOL);
    } catch {
      return this.#degrade(lexical, 'passage_vector_search_error');
    }
    if (!generationStillCurrent(this.#vectors, vector, epoch)) {
      return this.#degrade(lexical, 'passage_vector_search_error');
    }

    const vectorAnchors = this.#reader.byAnchors(neighbours.map(({ anchor }) => anchor), request.filters);
    const ordered =
      request.mode === 'semantic'
        ? vectorAnchors.map(({ anchor }) => anchor)
        : fuseByReciprocalRank(
            request.query,
            lexical.map((row) => row.anchor),
            vectorAnchors.map(({ anchor }) => anchor),
          );
    const rows = this.#reader.byAnchors(ordered, request.filters);
    const ranked = [...rows].sort((a, b) => Number(isDemoted(a)) - Number(isDemoted(b)));
    return { rows: ranked.slice(0, request.limit), degraded: false, effectiveMode: request.mode };
  }

  /**
   * Document anchors for a semantic request.
   *
   * Passage vectors are the finer index, so they answer first; their document
   * anchors are then ranked as documents. When no passage index exists yet the
   * document index answers directly, which is the same result at coarser
   * granularity rather than a different one.
   */
  #semanticAnchors(vector: MemoryQueryVector, filters: SearchFilters, limit: number): Array<{ anchor: string; distance: number }> {
    const passages = nearestPassages(this.#vectors, vector, CANDIDATE_POOL);
    if (passages.length === 0) return nearestDocuments(this.#vectors, vector, CANDIDATE_POOL);
    const seen = new Set<string>();
    const anchors: Array<{ anchor: string; distance: number }> = [];
    for (const { passageKey, distance } of passages) {
      const parsed = parsePassageVectorKey(passageKey);
      if (parsed === null || seen.has(parsed.docAnchor)) continue;
      seen.add(parsed.docAnchor);
      anchors.push({ anchor: parsed.docAnchor, distance });
    }
    // Scope is a hard boundary: a passage whose document the filters reject
    // must not contribute its position, so resolve admitted documents first.
    const admitted = new Set(this.#reader.byAnchors([...seen], filters).map((row) => row.anchor));
    return anchors.filter((entry) => admitted.has(entry.anchor)).slice(0, limit);
  }

  #lexical(query: string, filters: SearchFilters, limit: number): DocRow[] {
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
    collect(this.#reader.exactAnchor(query, filters));

    // Progressive relaxation stops at the first level that finds anything: a
    // looser pass only runs when the tighter one came back empty.
    for (const ftsQuery of buildProgressiveFtsQueries(query)) {
      const batch = this.#reader.fts(ftsQuery, filters, CANDIDATE_POOL);
      if (batch.length === 0) continue;
      collect(batch);
      break;
    }

    // Substring backfill recovers hits that unicode61 tokenization misses.
    if (rows.length === 0) {
      const words = splitLexicalBackfillWords(query);
      if (words.length > 0) collect(this.#reader.lexicalBackfill(words, filters, CANDIDATE_POOL));
    }

    // Superseded and drifted records sink behind current ones, matching how the
    // Host's own store orders the same rows.
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => Number(isDemoted(a.row)) - Number(isDemoted(b.row)) || a.index - b.index)
      .map(({ row }) => row)
      .slice(0, limit);
  }

  // ── Raw depth: passages ───────────────────────────────────────────

  /**
   * Rank passages and report them under the documents they belong to.
   *
   * A raw request asks "which passage matched", so the unit of ranking is the
   * passage and the unit of reporting is its document. Documents keep the order
   * of their best passage, and a hit carries only the passages that matched
   * rather than the whole document, which is what the Host returns.
   */
  async #raw(request: Request, contextWindow: number | undefined): Promise<RawExecuted> {
    const pool = Math.min(Math.max(request.limit * 4, 20), CANDIDATE_POOL);
    const lexical = this.#lexicalPassages(request.query, request.filters, pool);
    let candidates: PassageRow[];
    let degraded = false;
    let degradeReason: string | undefined;
    let effectiveMode: 'lexical' | 'semantic' | 'hybrid' = request.mode;

    if (request.mode === 'lexical') {
      candidates = lexical;
    } else {
      const vector = await this.#queryVector(request.query);
      const refusal =
        vector === null
          ? 'passage_embedding_unavailable'
          : !vectorIdentityMatches(this.#vectors, vector)
            ? 'passage_vector_search_error'
            : undefined;
      if (vector === null || refusal !== undefined) {
        candidates = lexical;
        degraded = true;
        degradeReason = refusal;
        effectiveMode = 'lexical';
      } else {
        const epoch = readGenerationEpoch(this.#vectors, vector);
        let semantic: PassageRow[];
        try {
          semantic = this.#semanticPassages(vector, request.filters, pool);
        } catch {
          semantic = [];
          degraded = true;
          degradeReason = 'passage_vector_search_error';
        }
        if (!generationStillCurrent(this.#vectors, vector, epoch)) {
          degraded = true;
          degradeReason = 'passage_vector_search_error';
        }
        if (degraded) {
          candidates = lexical;
          effectiveMode = 'lexical';
        } else if (request.mode === 'semantic') {
          candidates = semantic;
        } else {
          candidates = this.#fusePassages(request.query, lexical, semantic);
        }
      }
    }

    return this.#reportPassages(
      candidates,
      request.limit,
      request.filters,
      contextWindow,
      degraded,
      degradeReason,
      effectiveMode,
    );
  }

  #lexicalPassages(query: string, filters: SearchFilters, limit: number): PassageRow[] {
    for (const ftsQuery of buildProgressiveFtsQueries(query)) {
      const batch = this.#reader.ftsPassages(ftsQuery, filters, limit);
      if (batch.length > 0) return batch;
    }
    return [];
  }

  #semanticPassages(vector: MemoryQueryVector, filters: SearchFilters, limit: number): PassageRow[] {
    const keys = nearestPassages(this.#vectors, vector, limit).flatMap(({ passageKey }) => {
      const key = parsePassageVectorKey(passageKey);
      return key === null ? [] : [key];
    });
    return this.#reader.passagesByKeys(keys, filters);
  }

  /**
   * Fuse passage rankings by reciprocal rank, the same way the Host does.
   *
   * A passage found by both passes scores once in each; the identity is the
   * Host's own `[docAnchor, passageId]` key, so the two passes can only agree on
   * a passage when they mean the same one.
   */
  #fusePassages(query: string, lexical: PassageRow[], semantic: PassageRow[]): PassageRow[] {
    const keyOf = (passage: PassageRow) => passageKeyOf(passage.doc_anchor, passage.passage_id);
    const byKey = new Map([...semantic, ...lexical].map((passage) => [keyOf(passage), passage]));
    return fuseByReciprocalRank(query, lexical.map(keyOf), semantic.map(keyOf))
      .map((key) => byKey.get(key)!);
  }

  #reportPassages(
    candidates: readonly PassageRow[],
    limit: number,
    filters: SearchFilters,
    contextWindow: number | undefined,
    degraded: boolean,
    degradeReason: string | undefined,
    effectiveMode: 'lexical' | 'semantic' | 'hybrid',
  ): RawExecuted {
    // Rank the passages first, then keep the first `limit` documents they name;
    // ranking documents instead would let a document's best passage hide how
    // many other passages did not match at all.
    const orderedAnchors: string[] = [];
    for (const candidate of candidates) {
      if (!orderedAnchors.includes(candidate.doc_anchor)) orderedAnchors.push(candidate.doc_anchor);
    }
    const admitted = this.#reader.byAnchors(orderedAnchors, filters);
    const ranked = [...admitted]
      .sort(
        (a, b) =>
          Number(isDemoted(a)) - Number(isDemoted(b)) || orderedAnchors.indexOf(a.anchor) - orderedAnchors.indexOf(b.anchor),
      )
      .slice(0, limit);

    const withContext = ranked.map((row) => ({
      row,
      passages: candidates
        .filter((candidate) => candidate.doc_anchor === row.anchor)
        .map((candidate) => this.#withContext(candidate, contextWindow, filters)),
    }));
    return {
      documents: withContext.map((entry) => entry.row),
      summaries: new Map(
        withContext.flatMap((entry) => {
          const first = entry.passages[0];
          return first === undefined
            ? []
            : [[entry.row.anchor, `[passage match] ${first.speaker ? `${first.speaker}: ` : ''}${first.content.slice(0, 200)}`]];
        }),
      ),
      passages: new Map(withContext.map((entry) => [entry.row.anchor, entry.passages])),
      degraded,
      ...(degradeReason === undefined ? {} : { degradeReason }),
      effectiveMode,
    };
  }

  /**
   * A raw passage plus its surrounding window, when the caller asked for one.
   *
   * The window is context, not a match: it comes back nested under the passage
   * so a caller never mistakes a neighbour for something the ranker found, and
   * every neighbour is read inside the same boundaries as the match itself.
   */
  #withContext(
    passage: PassageRow,
    contextWindow: number | undefined,
    filters: SearchFilters,
  ): SearchPassageDto {
    const base = toPassage(passage);
    if (contextWindow === undefined || passage.position === null) return base;
    const neighbours = this.#reader
      .passagesAround(passage.doc_anchor, passage.position, contextWindow, filters)
      .filter((neighbour) => neighbour.passage_id !== passage.passage_id)
      .map(toPassage);
    return { ...base, context: neighbours };
  }

  // ── Shared paths ──────────────────────────────────────────────────

  /** A degraded answer keeps the lexical rows and says which reason applied. */
  #degrade(rows: DocRow[], reason: string): Executed {
    return { rows, degraded: true, degradeReason: reason, effectiveMode: 'lexical' };
  }

  async #queryVector(query: string): Promise<MemoryQueryVector | null> {
    if (this.#embedding === undefined || query.length === 0) return null;
    try {
      return await this.#embedding.embedQuery(query);
    } catch {
      // A Host that fails to produce a vector is unavailable, not fatal: the
      // caller still gets the lexical answer and is told it was degraded.
      return null;
    }
  }
}

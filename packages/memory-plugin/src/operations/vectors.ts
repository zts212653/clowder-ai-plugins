import type { MemoryQueryVector } from '../host-port.js';
import type { EvidenceConnection } from './evidence-database.js';

/**
 * Semantic and hybrid ranking over the vectors the Host already indexed.
 *
 * The Host owns the model, the generation and authorization. It answers with a
 * query vector and the identity that produced it; this module checks that the
 * vector is comparable with the rows in the evidence database before trusting
 * distances. Querying a vector table written by a different model returns
 * meaningless neighbours rather than an error, so the check is the whole point:
 * a mismatched generation is a reason to answer lexically, not to rank garbage.
 *
 * Retried from the Host's own `openVectorGeneration` / `VectorStore` contract so
 * both engines read the same physical tables the same way.
 */

/** Physical vector tables per generation. Host-owned names; never renamed, including on rollback. */
const GENERATIONS = {
  g0: {
    documents: 'evidence_vectors',
    passages: 'passage_vectors',
    metadata: 'embedding_meta',
  },
  g1: {
    documents: 'evidence_vectors_g1',
    passages: 'passage_vectors_g1',
    metadata: 'embedding_meta_g1',
  },
} as const;

type GenerationId = keyof typeof GENERATIONS;

/** One neighbour returned by the vec0 index. */
export interface VectorNeighbour {
  readonly anchor: string;
  readonly distance: number;
}

function generationTables(generationId: GenerationId | undefined) {
  return GENERATIONS[generationId ?? 'g0'];
}

/**
 * Whether the indexed vectors were produced by the model that answered this
 * query.
 *
 * A generation with no metadata at all is not comparable: the plugin can read
 * the tables but cannot prove they belong to this model, and a wrong-match
 * answer would look exactly like a right one.
 */
export function vectorIdentityMatches(db: EvidenceConnection, query: MemoryQueryVector): boolean {
  const generationId = query.model.generationId;
  if (generationId !== undefined && generationId !== 'g0' && generationId !== 'g1') return false;
  const { metadata } = generationTables(generationId);
  const exists = db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(metadata);
  if (!exists) return false;
  const rows = db
    .prepare(
      `SELECT key, value FROM ${metadata}
       WHERE key IN ('embedding_model_id','embedding_model_rev','embedding_dim','embedding_representation_fingerprint')`,
    )
    .all() as Array<{ key: string; value: string }>;
  const meta = new Map(rows.map((row) => [row.key, row.value]));
  return (
    meta.get('embedding_model_id') === query.model.modelId &&
    meta.get('embedding_model_rev') === query.model.modelRev &&
    meta.get('embedding_dim') === String(query.model.dim) &&
    (query.model.representationFingerprint === undefined ||
      meta.get('embedding_representation_fingerprint') === query.model.representationFingerprint)
  );
}

/**
 * Whether the generation was quarantined or its epoch moved since `epoch`.
 *
 * A quarantine means the index can no longer be trusted to reflect the
 * documents; an advanced epoch means sources changed under the query. Either
 * way the distances describe a different corpus than the one being ranked.
 */
export function generationStillCurrent(
  db: EvidenceConnection,
  query: MemoryQueryVector,
  epoch: string,
): boolean {
  const { metadata } = generationTables(query.model.generationId as GenerationId | undefined);
  const rows = db
    .prepare(`SELECT key, value FROM ${metadata} WHERE key IN ('vector_invalidation_epoch','vector_invalidation_quarantined')`)
    .all() as Array<{ key: string; value: string }>;
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return (values.get('vector_invalidation_epoch') ?? '0') === epoch && values.get('vector_invalidation_quarantined') !== '1';
}

/** Read the epoch a query is about to run against, before reading the index. */
export function readGenerationEpoch(db: EvidenceConnection, query: MemoryQueryVector): string {
  const { metadata } = generationTables(query.model.generationId as GenerationId | undefined);
  const row = db
    .prepare(`SELECT value FROM ${metadata} WHERE key = 'vector_invalidation_epoch'`)
    .get() as { value: string } | undefined;
  return row?.value ?? '0';
}

/**
 * Nearest neighbours by vector distance.
 *
 * `Float32Array` is what vec0 stores; passing a plain array of numbers makes the
 * driver bind an unsupported type, so the conversion happens here rather than at
 * every caller.
 */
export function nearestDocuments(
  db: EvidenceConnection,
  query: MemoryQueryVector,
  limit: number,
): VectorNeighbour[] {
  const { documents } = generationTables(query.model.generationId as GenerationId | undefined);
  const rows = db
    .prepare(`SELECT anchor, distance FROM ${documents} WHERE embedding MATCH ? AND k = ?`)
    .all(Float32Array.from(query.vector), limit) as Array<{ anchor: string; distance: number }>;
  return rows.map((row) => ({ anchor: row.anchor, distance: row.distance }));
}

export function nearestPassages(
  db: EvidenceConnection,
  query: MemoryQueryVector,
  limit: number,
): Array<{ passageKey: string; distance: number }> {
  const { passages } = generationTables(query.model.generationId as GenerationId | undefined);
  const rows = db
    .prepare(`SELECT passage_key, distance FROM ${passages} WHERE embedding MATCH ? AND k = ?`)
    .all(Float32Array.from(query.vector), limit) as Array<{ passage_key: string; distance: number }>;
  return rows.map((row) => ({ passageKey: row.passage_key, distance: row.distance }));
}

/**
 * A passage vector key is `JSON.stringify([docAnchor, passageId])`.
 *
 * The same shape the Host writes, so a key this plugin reads names the passage
 * the Host meant. An unreadable key is dropped rather than reinterpreted: a
 * guessed split would attach a passage to the wrong document.
 */
export function parsePassageVectorKey(key: string): { docAnchor: string; passageId: string } | null {
  try {
    const parsed = JSON.parse(key) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [docAnchor, passageId] = parsed as unknown[];
    if (typeof docAnchor !== 'string' || typeof passageId !== 'string') return null;
    return { docAnchor, passageId };
  } catch {
    return null;
  }
}

/** Host's own CJK weight: BM25 has poor CJK recall, so the vector path counts for more. */
const CJK_NN_WEIGHT = 1.5;

function hasCJKCharacters(text: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
}

/** Reciprocal rank fusion constant, unchanged from the Host. */
const RRF_K = 60;

/**
 * Fuse a lexical ranking with a vector ranking by reciprocal rank.
 *
 * Position, not score, is what fuses: BM25 and cosine distance are not on a
 * comparable scale, and any attempt to normalise them would encode a weighting
 * the Host never chose.
 */
export function fuseByReciprocalRank(
  query: string,
  lexicalAnchors: readonly string[],
  vectorAnchors: readonly string[],
): string[] {
  const weight = hasCJKCharacters(query) ? CJK_NN_WEIGHT : 1;
  const scores = new Map<string, number>();
  lexicalAnchors.forEach((anchor, index) => {
    scores.set(anchor, (scores.get(anchor) ?? 0) + 1 / (RRF_K + index));
  });
  vectorAnchors.forEach((anchor, index) => {
    scores.set(anchor, (scores.get(anchor) ?? 0) + weight / (RRF_K + index));
  });
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([anchor]) => anchor);
}

import {
  memoryIndexStatusRequest,
  type MemoryIndexStatusResult,
} from '@clowder-ai/plugin-memory-contract/maintenance';
import type Database from 'better-sqlite3';

function countVectors(db: Database.Database, table: string) {
  try {
    return { count: db.prepare<[], number>(`SELECT count(*) FROM ${table}`).pluck().get()!, readable: true };
  } catch {
    // The shadow rowids remain readable on connections without sqlite-vec.
    const rowids = `${table}_rowids`;
    const exists = db.prepare('SELECT 1 FROM sqlite_schema WHERE name = ?').get(rowids);
    return {
      count: exists ? db.prepare<[], number>(`SELECT count(*) FROM ${rowids}`).pluck().get()! : 0,
      readable: false,
    };
  }
}

export function dispatchIndexStatus(db: Database.Database, request: unknown): MemoryIndexStatusResult {
  const { input } = memoryIndexStatusRequest.parse(request);
  const suffix = input.generationId === 'g1' ? '_g1' : '';
  const metadataTable = `embedding_meta${suffix}`;
  const hasTable = db.prepare('SELECT 1 FROM sqlite_schema WHERE name = ?');
  const metadata = new Map(
    hasTable.get(metadataTable)
      ? db
          .prepare<[], { key: string; value: string }>(
            `SELECT key, value FROM ${metadataTable}
            WHERE key IN ('last_rebuild_at', 'embedding_model_id', 'vector_invalidation_quarantined')`,
          )
          .all()
          .map(({ key, value }) => [key, value])
      : [],
  );
  const documents = db
    .prepare<[], { total: number; threads: number; updatedAt: string | null }>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE kind = 'thread') AS threads,
       max(updated_at) AS updatedAt FROM evidence_docs`,
    )
    .get()!;
  const passageVectors = countVectors(db, `passage_vectors${suffix}`);
  return {
    docs_count: documents.total,
    threads_count: documents.threads,
    passages_count: hasTable.get('evidence_passages')
      ? db.prepare<[], number>('SELECT count(*) FROM evidence_passages').pluck().get()!
      : 0,
    edges_count: db.prepare<[], number>('SELECT count(*) FROM edges').pluck().get()!,
    vectors_count: countVectors(db, `evidence_vectors${suffix}`).count,
    passage_vectors_count: passageVectors.count,
    passageVectorsReadable: passageVectors.readable,
    generationQuarantined: metadata.get('vector_invalidation_quarantined') === '1',
    last_rebuild_at: metadata.get('last_rebuild_at') || documents.updatedAt,
    last_document_updated_at: documents.updatedAt,
    embedding_model: metadata.get('embedding_model_id') ?? null,
  };
}

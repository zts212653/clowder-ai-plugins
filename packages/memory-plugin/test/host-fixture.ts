import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { parse } from 'yaml';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';

import type { MemoryEmbeddingPort, MemoryThreadKvPort } from '../src/host-port.js';

export const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));

/** A directory the fixture may name for data locations; retrieval never writes it. */
export const dataDir = join(tmpdir(), 'memory-plugin-search-fixture');

/** The native binding the activation itself loads, so the fixture uses the same engine. */
const nativeBinding = fileURLToPath(
  new URL(`../dist/native/${process.platform}-${process.arch}-abi${process.versions.modules}.node`, import.meta.url),
);

/** The vec0 extension the activation stages beside that binding. */
const vecExtension = fileURLToPath(
  new URL(
    `../dist/native/vec0.${process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so'}`,
    import.meta.url,
  ),
);

/** The embedding model the fixture's vectors claim to come from. */
export const FIXTURE_MODEL = { modelId: 'fixture-embed', modelRev: 'r1', dim: 4 } as const;

/** A unit-ish 4-dim vector; only relative distance matters to the ranker. */
function vec(x: number, y: number, z = 0, w = 0): Float32Array {
  const raw = [x, y, z, w];
  const norm = Math.hypot(...raw) || 1;
  return Float32Array.from(raw.map((value) => value / norm));
}

/**
 * Create the evidence database the activation requires: schema 84, the document
 * and FTS tables every retrieval pass reads, and a couple of rows to rank.
 *
 * Built with the same engine and native binding the activation loads, because a
 * database created by a different engine would not prove the real path works.
 */
export function seedEvidenceDatabase(databasePath: string, withVectors = false): void {
  const db = new Database(databasePath, { nativeBinding });
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version VALUES (84);
    CREATE TABLE evidence_docs (
      anchor TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL,
      summary TEXT, keywords TEXT, source_path TEXT, source_hash TEXT, superseded_by TEXT,
      materialized_from TEXT, updated_at TEXT NOT NULL, pack_id TEXT, provenance_tier TEXT,
      provenance_source TEXT, generalizable INTEGER DEFAULT NULL, authority TEXT DEFAULT 'observed',
      activation TEXT DEFAULT 'query', verified_at TEXT, source_ids TEXT, summary_of_anchor TEXT,
      compression_rationale TEXT, contradicts TEXT, invalid_at TEXT, review_cycle_days INTEGER,
      world_id TEXT, scene_id TEXT, collection_id TEXT, review_status TEXT,
      first_indexed_at INTEGER NOT NULL DEFAULT 0, drill_down_json TEXT,
      review_revision INTEGER DEFAULT 0
    );
    CREATE VIRTUAL TABLE evidence_fts USING fts5(
      title, summary, keywords, content=evidence_docs, content_rowid=rowid
    );
  `);
  const insert = db.prepare(
    `INSERT INTO evidence_docs (anchor, kind, status, title, summary, keywords, updated_at, authority, activation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of [
    [
      'test:legacy-fixture-v0141',
      'lesson',
      'active',
      'Chrysanthemum v0141 migration witness',
      'Created by the published legacy Windows runtime with a stable record',
      '["migration","legacy"]',
      '2026-11-19T02:19:30.174Z',
      'observed',
      'query',
    ],
    [
      'F042',
      'feature',
      'active',
      'Memory pluginization',
      'Thread KV and evidence retrieval move to the plugin',
      '["memory","plugin"]',
      '2026-11-01T00:00:00.000Z',
      'validated',
      'query',
    ],
    [
      'test:superseded',
      'lesson',
      'superseded',
      'Chrysanthemum old note',
      'Superseded by the newer witness',
      '["migration"]',
      '2026-10-01T00:00:00.000Z',
      'observed',
      'query',
    ],
    [
      'test:backstop',
      'lesson',
      'active',
      'Chrysanthemum backstop',
      'Only visible to internal backstop rules',
      '["migration"]',
      '2026-11-02T00:00:00.000Z',
      'observed',
      'backstop',
    ],
    [
      'test:pull-only',
      'lesson',
      'active',
      'SealedMaterial',
      'Only used by explicit pull surfaces',
      '[]',
      '2026-11-19T02:19:30.174Z',
      'observed',
      'pull_only',
    ],
    [
      'thread-absent',
      'thread',
      'active',
      'Unrelated thread digest',
      'A thread that a filter for another id must not match',
      '["thread"]',
      '2026-11-03T00:00:00.000Z',
      'observed',
      'query',
    ],
  ])
    insert.run(...row);
  db.exec(`
    CREATE TABLE evidence_passages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, doc_anchor TEXT NOT NULL, passage_id TEXT NOT NULL,
      content TEXT NOT NULL, speaker TEXT, position INTEGER, created_at TEXT NOT NULL,
      UNIQUE(doc_anchor, passage_id)
    );
    CREATE VIRTUAL TABLE passage_fts USING fts5(content, content=evidence_passages, content_rowid=rowid,
      tokenize="unicode61 tokenchars '_-'");
  `);
  const passage = db.prepare(
    `INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  passage.run('test:legacy-fixture-v0141', 'p1', 'Opening migrated witness record', 'cat', 0, '2026-11-19T02:19:30.174Z');
  passage.run('test:legacy-fixture-v0141', 'p2', 'Chrysanthemum migration detail in the middle', 'cat', 1, '2026-11-19T02:20:00.000Z');
  passage.run('test:legacy-fixture-v0141', 'p3', 'Closing note after the migration', 'cat', 2, '2026-11-19T02:21:00.000Z');
  passage.run('test:pull-only', 'private', 'SealedMaterial passage', 'cat', 0, '2026-11-19T02:20:00.000Z');
  if (withVectors) {
    insert.run(VECTOR_ONLY_ANCHOR, 'lesson', 'active', 'Quartermaster log', 'Rotation of the night watch',
      '["rota"]', '2026-11-10T00:00:00.000Z', 'observed', 'query');
    passage.run(VECTOR_ONLY_ANCHOR, 'q1', 'Night watch rotation schedule', 'cat', 0, '2026-11-10T00:00:00.000Z');
    seedVectors(db);
  }
  db.exec(`
    INSERT INTO evidence_fts(rowid, title, summary, keywords)
      SELECT rowid, title, summary, keywords FROM evidence_docs;
    INSERT INTO passage_fts(rowid, content) SELECT rowid, content FROM evidence_passages;
  `);
  db.close();
}

export const VECTOR_ONLY_ANCHOR = 'test:vector-only';

function seedVectors(db: Database.Database): void {
  db.loadExtension(vecExtension);
  db.exec(`
    CREATE VIRTUAL TABLE evidence_vectors USING vec0(anchor TEXT PRIMARY KEY, embedding float[4]);
    CREATE VIRTUAL TABLE passage_vectors USING vec0(passage_key TEXT PRIMARY KEY, embedding float[4]);
    CREATE TABLE embedding_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  // Vectors: the vector-only document sits exactly on the query axis, the
  // lexical witness sits far from it, so a semantic request must find one and a
  // lexical one must find the other.
  const docVector = db.prepare('INSERT INTO evidence_vectors (anchor, embedding) VALUES (?, ?)');
  docVector.run(VECTOR_ONLY_ANCHOR, vec(1, 0));
  docVector.run('test:legacy-fixture-v0141', vec(0, 1));
  docVector.run('test:pull-only', vec(1, 0));
  const passageVector = db.prepare('INSERT INTO passage_vectors (passage_key, embedding) VALUES (?, ?)');
  passageVector.run(JSON.stringify([VECTOR_ONLY_ANCHOR, 'q1']), vec(1, 0));
  passageVector.run(JSON.stringify(['test:legacy-fixture-v0141', 'p2']), vec(0, 1));
  passageVector.run(JSON.stringify(['test:pull-only', 'private']), vec(1, 0));

  const meta = db.prepare('INSERT INTO embedding_meta (key, value) VALUES (?, ?)');
  meta.run('embedding_model_id', FIXTURE_MODEL.modelId);
  meta.run('embedding_model_rev', FIXTURE_MODEL.modelRev);
  meta.run('embedding_dim', String(FIXTURE_MODEL.dim));
  meta.run('vector_invalidation_epoch', '0');
}

/** In-memory Host port standing in for the authorized Redis hash surface. */
export function fakeKv() {
  const hashes = new Map<string, Map<string, string>>();
  const writes: string[] = [];
  /**
   * When set, the next compare-and-set reports a losing race once. This is the
   * concurrent-writer case the plugin's retry exists for, and it must not apply
   * the mutation on that attempt.
   */
  let loseNext = false;
  const port: MemoryThreadKvPort = {
    get: async (threadRef, key) => hashes.get(threadRef)?.get(key) ?? null,
    list: async (threadRef) => Object.fromEntries(hashes.get(threadRef) ?? []),
    compareAndSet: async (threadRef, expected, mutation) => {
      if (loseNext) {
        loseNext = false;
        return false;
      }
      const current = hashes.get(threadRef) ?? new Map<string, string>();
      const fields = Object.entries(expected);
      if (current.size !== fields.length || fields.some(([k, v]) => current.get(k) !== v)) return false;
      current.set(mutation.set.key, mutation.set.value);
      if (mutation.removeKey !== undefined && mutation.removeKey !== mutation.set.key) {
        current.delete(mutation.removeKey);
      }
      hashes.set(threadRef, current);
      writes.push(`${threadRef}/${mutation.set.key}`);
      return true;
    },
    delete: async (threadRef, key) => hashes.get(threadRef)?.delete(key) ?? false,
  };
  return {
    port,
    hashes,
    writes,
    loseNextCompareAndSet: () => {
      loseNext = true;
    },
  };
}

export function host(
  memoryThreadKv: unknown,
  evidencePath: string,
  dataDirectory: string = dataDir,
  embedding?: MemoryEmbeddingPort,
): ModulePluginHostShape {
  return {
    pluginInstanceId: 'memory-instance',
    config: { get: async () => undefined },
    secrets: { get: async () => undefined },
    storage: {
      get: async () => undefined,
      list: async () => ({}),
      set: async () => ({ revision: 1 }),
      compareAndSet: async () => ({ applied: true, revision: 1 }),
      delete: async () => ({ deleted: false }),
    },
    tasks: {
      get: async () => null,
      list: async () => [],
      create: async () => {
        throw new Error('unused');
      },
      update: async () => null,
    },
    threads: {
      get: async () => null,
      list: async () => [],
      readMessages: async () => {
        throw new Error('unused');
      },
      getCats: async () => {
        throw new Error('unused');
      },
      create: async () => {
        throw new Error('unused');
      },
      update: async () => {
        throw new Error('unused');
      },
      addParticipants: async () => {
        throw new Error('unused');
      },
    },
    messaging: {
      get: async () => null,
      send: async () => {
        throw new Error('unused');
      },
      subscribe: async () => {
        throw new Error('unused');
      },
      unsubscribe: async () => {
        throw new Error('unused');
      },
    },
    streams: {
      read: async function* () {
        throw new Error('unused');
      },
    },
    external: { endpoint: 'http://127.0.0.1/unused', token: 'unused' },
    dataPath: '/tmp/memory-plugin-test-data',
    log: () => undefined,
    memoryDatabase: { canonicalPath: evidencePath, storageFormat: 1 },
    memoryData: { dataDir: dataDirectory, eventDbPath: ':memory:' },
    // Retrieval never reads a Matter source, but the port set is required as a
    // whole: a plugin that silently started without it would look healthy while
    // the Matter paths it also serves were unusable.
    memorySource: {
      caller: async () => ({
        userId: 'fixture-owner',
        viewer: { type: 'user' },
        threadId: 'thread-1',
        invocationId: 'test',
      }),
      assertCurrent: async () => undefined,
      publishMatterChange: async () => undefined,
      canReadThread: async () => true,
      readMessage: async () => null,
      currentTrigger: async () => ({ status: 'ordinary' as const }),
    },
    ...(memoryThreadKv === undefined ? {} : { memoryThreadKv }),
    ...(embedding === undefined ? {} : { memoryEmbedding: embedding }),
  } as ModulePluginHostShape;
}

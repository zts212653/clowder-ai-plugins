import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

import { parse } from 'yaml';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';

import type { MemoryDatabasePort, MemoryThreadKvPort } from '../src/host-port.js';

export const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));

/**
 * The evidence coordinate stands in for the Host-resolved path. The plugin only
 * stores it at activation and opens it on a retrieval call, so KV tests never
 * touch the file.
 */
export const unusedDatabase: MemoryDatabasePort = {
  canonicalPath: '/tmp/memory-plugin-unused-evidence.sqlite',
  storageFormat: 1,
};

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
  memoryThreadKv?: unknown,
  memoryDatabase: unknown = unusedDatabase,
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
    ...(memoryThreadKv === undefined ? {} : { memoryThreadKv }),
    ...(memoryDatabase === undefined ? {} : { memoryDatabase }),
  } as ModulePluginHostShape;
}

/**
 * Create the evidence tables and FTS index exactly as the Host's own store
 * creates them, so retrieval is exercised against the real schema and the real
 * FTS5 semantics rather than a stand-in that happens to have similar columns.
 */
export function seedEvidenceDatabase(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  db.exec(`
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
      'thread-absent-thread',
      'thread',
      'active',
      'Unrelated thread digest',
      'A thread that the filter below must not match',
      '["thread"]',
      '2026-11-03T00:00:00.000Z',
      'observed',
      'query',
    ],
  ])
    insert.run(...row);
  db.exec(`INSERT INTO evidence_fts(rowid, title, summary, keywords)
           SELECT rowid, title, summary, keywords FROM evidence_docs`);
  db.close();
}

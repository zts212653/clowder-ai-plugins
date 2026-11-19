import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { parse } from 'yaml';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';

import type { MemoryThreadKvPort } from '../src/host-port.js';

export const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));

/** A directory the fixture may name for data locations; retrieval never writes it. */
export const dataDir = join(tmpdir(), 'memory-plugin-search-fixture');

/** The native binding the activation itself loads, so the fixture uses the same engine. */
const nativeBinding = fileURLToPath(
  new URL(`../dist/native/${process.platform}-${process.arch}-abi${process.versions.modules}.node`, import.meta.url),
);

/**
 * Create the evidence database the activation requires: schema 84, the document
 * and FTS tables every retrieval pass reads, and a couple of rows to rank.
 *
 * Built with the same engine and native binding the activation loads, because a
 * database created by a different engine would not prove the real path works.
 */
export function seedEvidenceDatabase(databasePath: string): void {
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
  db.exec(`INSERT INTO evidence_fts(rowid, title, summary, keywords)
           SELECT rowid, title, summary, keywords FROM evidence_docs`);
  db.close();
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
  } as ModulePluginHostShape;
}


import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { parse } from 'yaml';
import { validateManifest } from '@clowder-ai/plugin-contract';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { MEMORY_REQUIRED_OPERATIONS, MEMORY_SEARCH_OPERATIONS } from '@clowder-ai/plugin-memory-contract';
import { entityOutputSchemas } from '@clowder-ai/plugin-memory-contract/entity';
import { eventOutputSchemas } from '@clowder-ai/plugin-memory-contract/event';
import { memoryProjectIndexResponses } from '@clowder-ai/plugin-memory-contract/maintenance';
import { matterOutputSchemas } from '@clowder-ai/plugin-memory-contract/matter';
import { profileOutputSchemas } from '@clowder-ai/plugin-memory-contract/profile';

import { createMemoryPluginModule } from '../dist/plugin-entrypoint.js';
import type { MemoryThreadKvPort } from '../src/host-port.js';
import { openMemoryStorage } from '../dist/open-memory-storage.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));
let dataDir: string;
let evidencePath: string;

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'clowder-memory-module-'));
  evidencePath = join(dataDir, 'evidence.sqlite');
  const binding = `${process.platform}-${process.arch}-abi${process.versions.modules}.node`;
  const nativeBinding = fileURLToPath(new URL(`../dist/native/${binding}`, import.meta.url));
  const db = new Database(evidencePath, { nativeBinding });
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version VALUES (84);
    CREATE TABLE evidence_docs (
      anchor TEXT PRIMARY KEY, title TEXT, kind TEXT, collection_id TEXT, world_id TEXT, updated_at TEXT
    );
  `);
  db.close();
});

after(() => {
  rmSync(evidencePath, { force: true });
  rmdirSync(dataDir);
});

/** In-memory Host port standing in for the authorized Redis hash surface. */
function fakeKv() {
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
  return { port, hashes, writes, loseNextCompareAndSet: () => { loseNext = true; } };
}

function host(memoryThreadKv?: unknown): ModulePluginHostShape {
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
    memoryData: { dataDir, eventDbPath: ':memory:' },
    memorySource: {
      caller: async () => ({ userId: 'fixture-owner', viewer: { type: 'user' }, threadId: 'thread-1', invocationId: 'test' }),
      assertCurrent: async () => undefined,
      publishMatterChange: async () => undefined,
      canReadThread: async () => true,
      readMessage: async () => null,
      currentTrigger: async () => ({ status: 'ordinary' }),
    },
    ...(memoryThreadKv === undefined ? {} : { memoryThreadKv }),
  } as ModulePluginHostShape;
}

async function start(module = createMemoryPluginModule(), port: unknown = fakeKv().port) {
  return module.create(manifest).start(host(port));
}

/** Start with the memory port field omitted entirely, as an older Host would. */
async function startWithoutPorts(module = createMemoryPluginModule()) {
  return module.create(manifest).start(host(undefined));
}

test('manifest is a valid builtin module that declares its durable memory state', () => {
  const validation = validateManifest(manifest);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  assert.equal(manifest.runtime.transport, 'builtin');
  assert.equal(manifest.runtime.entrypoint, 'dist/plugin-entrypoint.js');
  const declared = new Set(manifest.data.map((entry: { name: string }) => entry.name));
  assert.ok(declared.has('memory-thread-kv'));
  assert.ok(declared.has('memory-evidence-index'));
});

test('memory.describe carries no business parameters and reports exactly the v1 contract', async (t) => {
  const active = await start();
  t.after(() => active.stop({ reason: 'test' }));
  const descriptor = (await active.actions['memory.describe']!({})) as {
    protocolMajor: number;
    operations: string[];
    storageFormat: number;
  };
  assert.deepEqual(descriptor, {
    protocolMajor: 1,
    operations: [
      ...MEMORY_REQUIRED_OPERATIONS,
      ...MEMORY_SEARCH_OPERATIONS,
      'index.status',
      'recall.stats',
      'recall.timeline',
      'recall.event',
      'recall.candidate',
      'recall.persist',
      'recall.anchors',
      'recall.anchors.refresh',
      'cue.invocation',
      ...Object.keys(memoryProjectIndexResponses),
      ...Object.keys(matterOutputSchemas),
      ...Object.keys(eventOutputSchemas),
      ...Object.keys(profileOutputSchemas),
      ...Object.keys(entityOutputSchemas),
    ],
    storageFormat: 1,
  });
});

test('storage drains an admitted write, then rejects writes submitted during shutdown', async () => {
  const memoryPorts = host(fakeKv().port) as unknown as Parameters<typeof openMemoryStorage>[0];
  const storage = await openMemoryStorage(memoryPorts);
  let completeWrite!: () => void;
  const write = storage.runWrite(() => new Promise<void>((resolve) => { completeWrite = resolve; }));
  await Promise.resolve();
  const stopping = storage.close();
  const late = assert.rejects(storage.runWrite(() => assert.fail('late write ran')), /memory_storage_closed/);
  completeWrite();
  await Promise.all([write, stopping, late]);
  assert.equal(storage.close(), stopping);
});

test('index status reads the selected generation and reports persisted vectors without a loaded extension', async (t) => {
  const binding = `${process.platform}-${process.arch}-abi${process.versions.modules}.node`;
  const nativeBinding = fileURLToPath(new URL(`../dist/native/${binding}`, import.meta.url));
  const db = new Database(evidencePath, { nativeBinding });
  db.exec(`
    INSERT INTO evidence_docs (anchor, kind, updated_at)
    VALUES ('status-thread', 'thread', '2026-11-18'), ('status-lesson', 'lesson', '2026-11-19');
    CREATE TABLE edges (anchor TEXT);
    INSERT INTO edges VALUES ('one');
    CREATE TABLE evidence_passages (content TEXT);
    INSERT INTO evidence_passages VALUES ('old'), ('new');
    CREATE TABLE embedding_meta_g1 (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO embedding_meta_g1 VALUES ('embedding_model_id', 'model-b'),
      ('last_rebuild_at', '2026-11-17'), ('vector_invalidation_quarantined', '1');
    CREATE TABLE passage_vectors_g1_rowids (id INTEGER PRIMARY KEY);
    INSERT INTO passage_vectors_g1_rowids VALUES (1);
    CREATE TABLE evidence_vectors_g1_rowids (id INTEGER PRIMARY KEY);
    INSERT INTO evidence_vectors_g1_rowids VALUES (1), (2);
  `);
  db.close();

  const active = await start();
  t.after(() => active.stop({ reason: 'test' }));
  const dispatch = active.actions['memory.dispatch']!;
  const status = await dispatch({ operation: 'index.status', input: { generationId: 'g1' } });
  const expected = {
    docs_count: 2,
    threads_count: 1,
    passages_count: 2,
    edges_count: 1,
    vectors_count: 2,
    passage_vectors_count: 1,
    passageVectorsReadable: false,
    generationQuarantined: true,
    last_rebuild_at: '2026-11-17',
    last_document_updated_at: '2026-11-19',
    embedding_model: 'model-b',
  };
  assert.deepEqual(status, expected);
  const previous = await dispatch({ operation: 'index.status', input: { generationId: 'g0' } });
  assert.deepEqual(previous, {
    ...expected,
    vectors_count: 0,
    passage_vectors_count: 0,
    generationQuarantined: false,
    last_rebuild_at: '2026-11-19',
    embedding_model: null,
  });
  await assert.rejects(async () => dispatch({ operation: 'index.status', input: { generationId: 'embedding_meta' } }));
});

test('project index claims and settles legacy state through the activation writer', async (t) => {
  const binding = `${process.platform}-${process.arch}-abi${process.versions.modules}.node`;
  const nativeBinding = fileURLToPath(new URL(`../dist/native/${binding}`, import.meta.url));
  const db = new Database(evidencePath, { nativeBinding });
  db.exec(`
    CREATE TABLE index_state (
      id TEXT PRIMARY KEY, project_path TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'missing',
      fingerprint TEXT NOT NULL DEFAULT '', last_scan_at TEXT, snoozed_until TEXT,
      docs_indexed INTEGER DEFAULT 0, docs_total INTEGER DEFAULT 0,
      error_message TEXT, summary_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT INTO index_state (id, project_path, status, fingerprint, docs_indexed, created_at, updated_at)
    VALUES ('legacy-project-id', ?, 'ready', 'old-revision', 4, '2026-11-18', '2026-11-18')
  `).run(dataDir);
  db.close();

  const active = await start();
  t.after(() => active.stop({ reason: 'test' }));
  const call = (action: string, options = {}) =>
    active.actions['memory.dispatch']!({ operation: `index.project.${action}`, input: { projectPath: dataDir, ...options } });
  const old = await call('read', { fingerprint: 'new-revision' });
  assert.equal((old as { status: string }).status, 'stale');
  assert.deepEqual(await Promise.all([
    call('claim', { fingerprint: 'new-revision' }),
    call('claim', { fingerprint: 'new-revision' }),
  ]), [true, false]);
  await call('settle', { status: 'ready', docsIndexed: 7, summaryJson: '{"projectName":"legacy-test"}' });
  const current = await call('read') as { id: string; status: string; docs_indexed: number; summary_json: string };
  assert.equal(current.id, 'legacy-project-id');
  assert.equal(current.status, 'ready');
  assert.equal(current.docs_indexed, 7);
  assert.equal(current.summary_json, '{"projectName":"legacy-test"}');
  assert.equal(typeof await call('snooze'), 'string');
  assert.equal(await call('claim', { fingerprint: 'later-revision' }), false);

  const interruptedPath = join(dataDir, 'interrupted');
  const claim = { operation: 'index.project.claim', input: { projectPath: interruptedPath, fingerprint: 'new-revision' } };
  assert.equal(await active.actions['memory.dispatch']!(claim), true);
  await active.stop({ reason: 'test' });
  const restarted = await start();
  t.after(() => restarted.stop({ reason: 'test' }));
  const interrupted = await restarted.actions['memory.dispatch']!({
    operation: 'index.project.read', input: { projectPath: interruptedPath },
  });
  assert.equal((interrupted as { status: string }).status, 'stale');
  assert.equal(await restarted.actions['memory.dispatch']!(claim), true);
});

test('recall reads preserve authorized thread scope, time windows and cursor order', async (t) => {
  const binding = `${process.platform}-${process.arch}-abi${process.versions.modules}.node`;
  const nativeBinding = fileURLToPath(new URL(`../dist/native/${binding}`, import.meta.url));
  const db = new Database(evidencePath, { nativeBinding });
  db.exec(`
    CREATE TABLE recall_events (
      source TEXT, push_surface TEXT, tool_name TEXT, inspected INTEGER,
      outcome TEXT, timestamp INTEGER, thread_id TEXT,
      recall_id TEXT, cat_id TEXT, invocation_id TEXT
    );
    INSERT INTO recall_events VALUES
      ('pull', NULL, 'search', 1, 'used', 100, 'owned', 'r1', 'codex', 'i1'),
      ('pull', NULL, 'search', 0, NULL, 199, 'owned', 'r2', 'codex', 'i2'),
      ('push', 'cue', NULL, 1, NULL, 200, 'owned', 'r3', 'opus', 'i3'),
      ('pull', NULL, 'search', 1, 'used', 99, 'owned', 'r4', 'codex', 'i4'),
      ('pull', NULL, 'search', 1, 'used', 201, 'owned', 'r5', 'codex', 'i5'),
      ('pull', NULL, 'search', 1, 'used', 150, 'foreign', 'r6', 'codex', 'i6');
    ALTER TABLE recall_events ADD COLUMN query TEXT DEFAULT '';
    ALTER TABLE recall_events ADD COLUMN mode TEXT;
    ALTER TABLE recall_events ADD COLUMN scope TEXT;
    ALTER TABLE recall_events ADD COLUMN candidates_json TEXT DEFAULT '[]';
    ALTER TABLE recall_events ADD COLUMN consumed_json TEXT DEFAULT '[]';
    ALTER TABLE recall_events ADD COLUMN source_event_id TEXT;
    ALTER TABLE recall_events ADD COLUMN result_count INTEGER;
    ALTER TABLE recall_events ADD COLUMN result_status TEXT;
    ALTER TABLE recall_events ADD COLUMN reformulated INTEGER;
    ALTER TABLE recall_events ADD COLUMN fell_back_to_grep INTEGER;
    ALTER TABLE recall_events ADD COLUMN abandoned INTEGER;
    ALTER TABLE recall_events ADD COLUMN next_graph_resolve_after_read INTEGER;
    ALTER TABLE recall_events ADD COLUMN token_cost INTEGER;
    ALTER TABLE recall_events ADD COLUMN shadow_ranking_json TEXT;
    ALTER TABLE recall_events ADD COLUMN result_set_id TEXT;
    ALTER TABLE recall_events ADD COLUMN attribution_clarity TEXT;
    ALTER TABLE recall_events ADD COLUMN presented INTEGER;
    ALTER TABLE recall_events ADD COLUMN expansion_funnel_json TEXT;
    CREATE UNIQUE INDEX recog_source_event ON recall_events(source_event_id);
    CREATE TABLE anchor_recall_metrics (
      anchor TEXT PRIMARY KEY, consumed_count_30d INTEGER, exposure_count_30d INTEGER,
      last_consumed_at TEXT, dormancy_days INTEGER, updated_at TEXT
    );
    CREATE TABLE global_ctr_baseline (
      doc_kind TEXT PRIMARY KEY, mean_ctr REAL, sample_count INTEGER, updated_at INTEGER
    );
    INSERT INTO evidence_docs (anchor, title, kind, collection_id, world_id) VALUES
      ('F042', 'Public feature', 'feature', NULL, NULL),
      ('secret-collection', 'Private collection title', 'feature', 'private:owner', NULL),
      ('secret-world', 'Private world title', 'feature', NULL, 'world-a'),
      ('gotcha-internal', 'Internal title', 'thread', NULL, NULL);
    CREATE TABLE memory_cue_events (
      owner_user_id TEXT, thread_id TEXT, invocation_id TEXT, cue_id TEXT,
      occurred_at INTEGER, axis TEXT, consumption_outcome TEXT, read_origin TEXT, consumer_cat_id TEXT
    );
    INSERT INTO memory_cue_events VALUES
      ('fixture-owner', 'owned', 'c1', 'cue1', 200, 'consumption', 'presented', 'explicit_read', 'codex'),
      ('other-owner', 'owned', 'c2', 'cue2', 200, 'consumption', 'presented', 'explicit_read', 'codex'),
      ('fixture-owner', 'foreign', 'c3', 'cue3', 200, 'consumption', 'presented', 'explicit_read', 'codex');
    ALTER TABLE memory_cue_events ADD COLUMN event_id TEXT DEFAULT 'fixture-event';
    ALTER TABLE memory_cue_events ADD COLUMN idempotency_key TEXT DEFAULT 'fixture-key';
    ALTER TABLE memory_cue_events ADD COLUMN opportunity_id TEXT DEFAULT 'preparation-fixture';
    ALTER TABLE memory_cue_events ADD COLUMN resolver_family TEXT DEFAULT 'taste';
    ALTER TABLE memory_cue_events ADD COLUMN source_anchor TEXT DEFAULT 'fixture-taste';
    ALTER TABLE memory_cue_events ADD COLUMN source_revision TEXT DEFAULT 'r1';
    ALTER TABLE memory_cue_events ADD COLUMN invalidation_reason TEXT;
    ALTER TABLE memory_cue_events ADD COLUMN catalog_version INTEGER DEFAULT 9;
    ALTER TABLE memory_cue_events ADD COLUMN resolver_version INTEGER DEFAULT 1;
    ALTER TABLE memory_cue_events ADD COLUMN created_at TEXT DEFAULT '2026-11-19T00:00:00Z';
    ALTER TABLE memory_cue_events ADD COLUMN read_details_json TEXT;
  `);
  db.close();
  const active = await start();
  t.after(() => active.stop({ reason: 'test' }));
  const dispatch = active.actions['memory.dispatch']!;
  const request = { operation: 'recall.stats', input: { threadIds: ['owned'], from: 100, to: 200 } };
  assert.deepEqual(await dispatch(request), [
    { source: 'push', surface: 'cue', presented: 1, inspected: 1, used: 0 },
    { source: 'pull', surface: 'search', presented: 2, inspected: 1, used: 1 },
  ]);
  assert.deepEqual(await dispatch({ ...request, input: { ...request.input, threadIds: [] } }), []);
  await assert.rejects(async () => dispatch({ ...request, input: { ...request.input, from: 201 } }));

  const timeline = { operation: 'recall.timeline', input: { ...request.input, source: 'pull', catId: 'codex', limit: 1 } };
  const first = await dispatch(timeline) as { at: number; key: string; cue_id: string | null; recall_id: string | null }[];
  assert.deepEqual(first.map(({ recall_id, cue_id }) => recall_id ?? cue_id), ['cue1', 'r2']);
  const second = await dispatch({ ...timeline, input: { ...timeline.input, before: { at: first[0].at, key: first[0].key } } }) as typeof first;
  assert.deepEqual(second.map(({ recall_id, cue_id }) => recall_id ?? cue_id), ['r2', 'r1']);
  const read = { operation: 'recall.event', input: { recallId: 'r1', threadId: 'owned' } };
  assert.equal((await dispatch(read) as { recall_id: string; inspected: number }).inspected, 1);
  assert.equal(await dispatch({ ...read, input: { ...read.input, threadId: 'foreign' } }), null);
  const title = { operation: 'recall.candidate', input: { anchor: 'F042', kinds: ['feature', 'lesson'] } };
  assert.deepEqual(await dispatch(title), { title: 'Public feature', kind: 'feature' });
  for (const anchor of ['secret-collection', 'secret-world', 'gotcha-internal', 'missing']) {
    assert.equal(await dispatch({ ...title, input: { ...title.input, anchor } }), null);
  }
  const cue = { operation: 'cue.invocation', input: { threadId: 'owned', invocationId: 'c1' } };
  assert.deepEqual(await dispatch(cue), [{
    cueId: 'cue1', resolverFamily: 'taste', sourceAnchor: 'fixture-taste', sourceRevision: 'r1',
    consumerCatId: 'codex', source: 'pull', status: 'presented_unreported', invalidationReason: null,
    presentedAt: 200, lastEventAt: 200,
  }]);
  assert.deepEqual(await dispatch({ ...cue, input: { ...cue.input, invocationId: 'c2' } }), []);
  assert.deepEqual(await dispatch({ ...cue, input: { ...cue.input, threadId: 'foreign' } }), []);
  const persist = { operation: 'recall.persist', input: { events: [{
    recallId: 'new-recall', sourceEventId: 'stable-r1', threadId: 'thread-1', catId: 'codex', invocationId: 'test',
    toolName: 'search_evidence', query: 'indexed witness', source: 'pull', presented: true, inspected: true,
    outcome: 'used', resultCount: 1, resultStatus: 'counted',
    candidates: [{ anchor: 'F042', rank: 0, targetRef: { kind: 'doc', sourcePath: 'docs/F042.md' } }],
    consumed: [{ anchor: 'F042', rank: 0, method: 'Read' }],
    reformulated: false, fellBackToGrep: false, abandoned: false, nextGraphResolveAfterRead: false,
    tokenCost: 0, timestamp: Date.now(),
  }] } };
  assert.equal(await dispatch(persist), null);
  const [firstWrite] = persist.input.events;
  assert.equal(await dispatch({ ...persist, input: { events: [{ ...firstWrite, recallId: 'retry', query: 'must not replace' }] } }), null);
  const persisted = await dispatch({ operation: 'recall.event', input: { recallId: 'new-recall', threadId: 'thread-1' } }) as {
    query: string; result_status: string; consumed_json: string;
  };
  assert.equal(persisted.query, 'indexed witness');
  assert.equal(persisted.result_status, 'counted');
  assert.deepEqual(JSON.parse(persisted.consumed_json), firstWrite.consumed);
  assert.equal(await dispatch({ operation: 'recall.event', input: { recallId: 'retry', threadId: 'thread-1' } }), null);
  const anchors = { operation: 'recall.anchors', input: { limit: 10 } };
  assert.deepEqual(await dispatch(anchors), [{
    anchor: 'F042', consumedCount30d: 1, exposureCount30d: 1,
    lastConsumedAt: new Date(firstWrite.timestamp).toISOString(), dormancyDays: 0,
  }]);
  assert.deepEqual(await dispatch({ ...anchors, input: { limit: 10, dormancyThreshold: 30, refresh: true } }), []);
  assert.equal(await dispatch({ operation: 'recall.anchors.refresh', input: {} }), null);
  await assert.rejects(async () => dispatch({ ...persist, input: { events: [{ ...firstWrite, threadId: 'foreign' }] } }));
});

test('a Host without the authorized memory port fails admission instead of degrading to an empty store', async () => {
  await assert.rejects(startWithoutPorts, /memoryThreadKv|memory ports/);
  await assert.rejects(async () => start(createMemoryPluginModule(), {}), /memoryThreadKv/i);
  // A port missing compareAndSet cannot keep the ceiling atomically, so it is not accepted either.
  await assert.rejects(
    async () => start(createMemoryPluginModule(), { get: 'nope', list: 'nope', delete: 'nope' }),
    /memoryThreadKv/i,
  );
});

test('the built worker writes and reads Event state through its authorized source scope', async (t) => {
  const active = await start();
  t.after(() => active.stop({ reason: 'test' }));
  const dispatch = active.actions['memory.dispatch']!;
  const saved = eventOutputSchemas['event.mark'].parse(await dispatch({
    operation: 'event.mark',
    input: {
      type: 'test_event', trigger: 'lesson_settle', cat: 'codex', threadId: 'thread-1', messageId: 'message-1',
      timestamp: 1700000000000, summary: 'Event through the built worker',
      cognitiveTransition: null, relatedHarness: null, confidence: 'high',
    },
  }));
  assert.equal(saved.inserted, true);
  assert.equal(saved.event?.ownerUserId, 'fixture-owner');
  assert.deepEqual(
    await dispatch({ operation: 'event.get', input: { eventId: saved.event?.eventId } }),
    saved.event,
  );
});

test("a second installation does not inherit the first installation's authorized ports", async () => {
  const first = fakeKv();
  const module = createMemoryPluginModule();
  const active = await module.create(manifest).start(host(first.port));
  await active.stop({ reason: 'test' });

  // A fresh definition for the same manifest must fail closed again.
  await assert.rejects(startWithoutPorts, /memoryThreadKv|memory ports/);
});

test('kv.put writes the exact Host entry shape and reads it back through the authorized port', async (t) => {
  const kv = fakeKv();
  const active = await start(createMemoryPluginModule(), kv.port);
  t.after(() => active.stop({ reason: 'test' }));

  const written = (await active.actions['memory.dispatch']!({
    operation: 'kv.put',
    input: { threadRef: 'thread-1', key: 'project', value: 'clowder', updatedBy: 'cat-codex' },
  })) as { key: string; value: string; threadId: string; updatedBy: string; updatedAt: number };

  assert.equal(written.key, 'project');
  assert.equal(written.value, 'clowder');
  assert.equal(written.threadId, 'thread-1');
  assert.equal(written.updatedBy, 'cat-codex');
  assert.equal(typeof written.updatedAt, 'number');

  const raw = kv.hashes.get('thread-1')!.get('project')!;
  assert.deepEqual(JSON.parse(raw), written);

  const read = await active.actions['memory.dispatch']!({
    operation: 'kv.get',
    input: { threadRef: 'thread-1', key: 'project' },
  });
  assert.deepEqual(read, written);
  assert.deepEqual(kv.writes, ['thread-1/project']);
});

test('kv.get distinguishes an absent key from a stored empty result and skips malformed records', async (t) => {
  const kv = fakeKv();
  kv.hashes.set('thread-1', new Map([['broken', '{not json']]));
  const active = await start(createMemoryPluginModule(), kv.port);
  t.after(() => active.stop({ reason: 'test' }));

  assert.equal(
    await active.actions['memory.dispatch']!({ operation: 'kv.get', input: { threadRef: 'thread-1', key: 'absent' } }),
    null,
  );
  assert.equal(
    await active.actions['memory.dispatch']!({ operation: 'kv.get', input: { threadRef: 'thread-1', key: 'broken' } }),
    null,
  );
});

test('kv.list returns every readable entry ordered by updatedAt ascending, skipping malformed records', async (t) => {
  const kv = fakeKv();
  kv.hashes.set(
    'thread-1',
    new Map([
      ['b', JSON.stringify({ key: 'b', value: '2', threadId: 'thread-1', updatedBy: 'user', updatedAt: 20 })],
      ['a', JSON.stringify({ key: 'a', value: '1', threadId: 'thread-1', updatedBy: 'user', updatedAt: 10 })],
      ['broken', 'not json'],
    ]),
  );
  const active = await start(createMemoryPluginModule(), kv.port);
  t.after(() => active.stop({ reason: 'test' }));

  const listed = (await active.actions['memory.dispatch']!({
    operation: 'kv.list',
    input: { threadRef: 'thread-1' },
  })) as { key: string }[];
  assert.deepEqual(
    listed.map((entry) => entry.key),
    ['a', 'b'],
  );
});

test('capacity keeps the 50-key ceiling by evicting the oldest entry only when the key is new', async (t) => {
  const kv = fakeKv();
  const seed = new Map<string, string>();
  for (let index = 0; index < 50; index++) {
    seed.set(
      `k${index}`,
      JSON.stringify({ key: `k${index}`, value: 'v', threadId: 'thread-1', updatedBy: 'user', updatedAt: index }),
    );
  }
  kv.hashes.set('thread-1', seed);
  const active = await start(createMemoryPluginModule(), kv.port);
  t.after(() => active.stop({ reason: 'test' }));

  // Overwriting an existing key must not evict anything.
  await active.actions['memory.dispatch']!({
    operation: 'kv.put',
    input: { threadRef: 'thread-1', key: 'k0', value: 'again', updatedBy: 'user' },
  });
  assert.equal(kv.hashes.get('thread-1')!.size, 50);
  assert.ok(kv.hashes.get('thread-1')!.has('k0'));

  // A new key at capacity evicts the single oldest entry and keeps the new one.
  // `k0` was just rewritten with a fresh timestamp, so `k1` is now the oldest.
  await active.actions['memory.dispatch']!({
    operation: 'kv.put',
    input: { threadRef: 'thread-1', key: 'fresh', value: 'v', updatedBy: 'user' },
  });
  assert.equal(kv.hashes.get('thread-1')!.size, 50);
  assert.equal(kv.hashes.get('thread-1')!.has('fresh'), true);
  assert.equal(kv.hashes.get('thread-1')!.has('k1'), false, 'the oldest entry is the one evicted');
  assert.equal(kv.hashes.get('thread-1')!.has('k0'), true, 'the just-rewritten key survives');
});

test('a losing compare-and-set re-reads and retries instead of reporting a false success', async (t) => {
  const kv = fakeKv();
  const active = await start(createMemoryPluginModule(), kv.port);
  t.after(() => active.stop({ reason: 'test' }));

  kv.loseNextCompareAndSet();
  const written = (await active.actions['memory.dispatch']!({
    operation: 'kv.put',
    input: { threadRef: 'thread-1', key: 'raced', value: 'v', updatedBy: 'user' },
  })) as { key: string };
  assert.equal(written.key, 'raced');
  assert.equal(kv.hashes.get('thread-1')!.has('raced'), true, 'the retry actually landed the write');
});

test('kv.delete reports whether a record existed', async (t) => {
  const kv = fakeKv();
  kv.hashes.set(
    'thread-1',
    new Map([['a', JSON.stringify({ key: 'a', value: '1', threadId: 'thread-1', updatedBy: 'user', updatedAt: 1 })]]),
  );
  const active = await start(createMemoryPluginModule(), kv.port);
  t.after(() => active.stop({ reason: 'test' }));

  assert.equal(
    await active.actions['memory.dispatch']!({ operation: 'kv.delete', input: { threadRef: 'thread-1', key: 'a' } }),
    true,
  );
  assert.equal(
    await active.actions['memory.dispatch']!({ operation: 'kv.delete', input: { threadRef: 'thread-1', key: 'a' } }),
    false,
  );
});

test('the deployment default key family is an ordinary authorized thread, never a rebuilt key', async (t) => {
  const kv = fakeKv();
  const active = await start(createMemoryPluginModule(), kv.port);
  t.after(() => active.stop({ reason: 'test' }));

  await active.actions['memory.dispatch']!({
    operation: 'kv.put',
    input: { threadRef: 'default', key: 'deploy', value: 'node', updatedBy: 'user' },
  });
  // The plugin hands the threadRef through verbatim; it never derives a physical key itself.
  assert.deepEqual(kv.writes, ['default/deploy']);
  assert.deepEqual(
    await active.actions['memory.dispatch']!({ operation: 'kv.get', input: { threadRef: 'default', key: 'deploy' } }),
    {
      key: 'deploy',
      value: 'node',
      threadId: 'default',
      updatedBy: 'user',
      updatedAt: (JSON.parse(kv.hashes.get('default')!.get('deploy')!) as { updatedAt: number }).updatedAt,
    },
  );
});

test('an unknown operation and an invalid payload are rejected at the boundary without touching storage', async (t) => {
  const kv = fakeKv();
  const active = await start(createMemoryPluginModule(), kv.port);
  t.after(() => active.stop({ reason: 'test' }));

  await assert.rejects(
    async () => active.actions['memory.dispatch']!({ operation: 'kv.nope', input: {} }),
    /unknown memory operation/,
  );
  await assert.rejects(
    async () => active.actions['memory.dispatch']!({ operation: 'kv.put', input: { threadRef: 'thread-1' } }),
    /key/,
  );
  assert.deepEqual(kv.writes, []);
});

test('after stop the dispatcher is revoked and writes stop', async () => {
  const kv = fakeKv();
  const active = await start(createMemoryPluginModule(), kv.port);
  await active.stop({ reason: 'test' });
  await assert.rejects(
    async () =>
      active.actions['memory.dispatch']!({
        operation: 'kv.put',
        input: { threadRef: 'thread-1', key: 'k', value: 'v', updatedBy: 'user' },
      }),
    /revoked|stopped|disposed/,
  );
  assert.deepEqual(kv.writes, []);
});

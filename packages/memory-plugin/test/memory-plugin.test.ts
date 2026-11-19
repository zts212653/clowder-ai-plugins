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
import { MEMORY_REQUIRED_OPERATIONS } from '@clowder-ai/plugin-memory-contract';
import { entityOutputSchemas } from '@clowder-ai/plugin-memory-contract/entity';
import { eventOutputSchemas } from '@clowder-ai/plugin-memory-contract/event';
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
  db.exec('CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (84);');
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

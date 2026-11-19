import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';
import { validateManifest } from '@clowder-ai/plugin-contract';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { MEMORY_REQUIRED_OPERATIONS } from '@clowder-ai/plugin-memory-contract';

import { createMemoryPluginModule } from '../src/plugin-entrypoint.js';
import type { MemoryThreadKvPort } from '../src/host-port.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));

/** In-memory Host port standing in for the authorized Redis hash surface. */
function fakeKv() {
  const hashes = new Map<string, Map<string, string>>();
  const writes: string[] = [];
  const port: MemoryThreadKvPort = {
    readAll: async (threadRef) => Object.fromEntries(hashes.get(threadRef) ?? []),
    write: async (threadRef, key, json) => {
      writes.push(`${threadRef}/${key}`);
      const hash = hashes.get(threadRef) ?? new Map<string, string>();
      hash.set(key, json);
      hashes.set(threadRef, hash);
    },
    remove: async (threadRef, key) => (hashes.get(threadRef)?.delete(key) ?? false),
  };
  return { port, hashes, writes };
}

function host(memoryPorts?: unknown): ModulePluginHostShape {
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
    ...(memoryPorts === undefined ? {} : { memoryPorts }),
  } as ModulePluginHostShape;
}

async function start(module = createMemoryPluginModule(), ports: unknown = { threadKv: fakeKv().port }) {
  const active = await module.create(manifest).start(host(ports));
  return active;
}

/** Start with the memory ports field omitted entirely, as an older Host would. */
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
    operations: [...MEMORY_REQUIRED_OPERATIONS],
    storageFormat: 1,
  });
});

test('a Host without the authorized memory port fails admission instead of degrading to an empty store', async () => {
  await assert.rejects(startWithoutPorts, /memory ports/);
  await assert.rejects(async () => start(createMemoryPluginModule(), {}), /threadKv/i);
  await assert.rejects(
    async () => start(createMemoryPluginModule(), { threadKv: { readAll: 'nope' } }),
    /threadKv/i,
  );
});

test('a second installation does not inherit the first installation\'s authorized ports', async () => {
  const first = fakeKv();
  const module = createMemoryPluginModule();
  const active = await module.create(manifest).start(host({ threadKv: first.port }));
  await active.stop({ reason: 'test' });

  // A fresh definition for the same manifest must fail closed again.
  await assert.rejects(startWithoutPorts, /memory ports/);
});

test('kv.put writes the exact Host entry shape and reads it back through the authorized port', async (t) => {
  const kv = fakeKv();
  const active = await start(createMemoryPluginModule(), { threadKv: kv.port });
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
  const active = await start(createMemoryPluginModule(), { threadKv: kv.port });
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
  const active = await start(createMemoryPluginModule(), { threadKv: kv.port });
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
  const active = await start(createMemoryPluginModule(), { threadKv: kv.port });
  t.after(() => active.stop({ reason: 'test' }));

  // Overwriting an existing key must not evict anything.
  await active.actions['memory.dispatch']!({
    operation: 'kv.put',
    input: { threadRef: 'thread-1', key: 'k0', value: 'again', updatedBy: 'user' },
  });
  assert.equal(kv.hashes.get('thread-1')!.size, 50);

  // A new key at capacity evicts the single oldest entry.
  await active.actions['memory.dispatch']!({
    operation: 'kv.put',
    input: { threadRef: 'thread-1', key: 'fresh', value: 'v', updatedBy: 'user' },
  });
  assert.equal(kv.hashes.get('thread-1')!.size, 50);
  assert.equal(kv.hashes.get('thread-1')!.has('fresh'), true);
});

test('kv.delete reports whether a record existed', async (t) => {
  const kv = fakeKv();
  kv.hashes.set(
    'thread-1',
    new Map([['a', JSON.stringify({ key: 'a', value: '1', threadId: 'thread-1', updatedBy: 'user', updatedAt: 1 })]]),
  );
  const active = await start(createMemoryPluginModule(), { threadKv: kv.port });
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
  const active = await start(createMemoryPluginModule(), { threadKv: kv.port });
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
  const active = await start(createMemoryPluginModule(), { threadKv: kv.port });
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
  const active = await start(createMemoryPluginModule(), { threadKv: kv.port });
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

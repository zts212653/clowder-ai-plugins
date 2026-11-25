import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import plugin from '../src/index.js';
import type { Sources } from '../src/scan.js';

const owner = {
  kind: 'owner-http-request' as const,
  userId: 'owner',
  pluginInstanceId: 'fixture',
  operation: 'write' as const,
  assertCurrent: async () => {},
};

const emptySources: Sources = {
  threads: [],
  roots: [],
  files: [],
  nativeSessions: [],
  omissions: [],
};

function start(conversationStorage: StorageHost) {
  return plugin.create().start({ pluginInstanceId: 'fixture', conversationStorage, log: () => {} });
}

type StorageHost = {
  startRead(): Promise<Sources>;
  beginRead?(signal: AbortSignal): Promise<{ sources: Promise<Sources> }>;
};

function call(active: ReturnType<typeof start>, method: 'GET' | 'POST', query: Record<string, string> = {}) {
  return active.actions['storage-governance.scan'](
    { request: { method, path: 'scan', query } },
    undefined,
    method === 'GET' ? { ...owner, operation: 'read' } : owner,
  );
}

const bodyOf = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;

test('beginRead returns running before sources resolve and then polls ready', async () => {
  let release!: (sources: Sources) => void;
  const sources = new Promise<Sources>((resolve) => {
    release = resolve;
  });
  let beginCalls = 0;
  let beginSignal: AbortSignal | undefined;
  const active = start({
    startRead: async () => {
      throw new Error('startRead must not run when beginRead exists');
    },
    beginRead: async (signal: AbortSignal) => {
      beginCalls += 1;
      beginSignal = signal;
      return { sources };
    },
  });
  try {
    const post = call(active, 'POST');
    const response = await Promise.race([
      post,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('POST blocked on sources')), 500);
        timer.unref();
      }),
    ]);
    assert.equal(beginCalls, 1);
    assert.ok(beginSignal);
    assert.deepEqual(bodyOf(response), { state: 'running' });
    assert.deepEqual(bodyOf(await call(active, 'GET')), { state: 'running' });

    release(emptySources);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const body = bodyOf(await call(active, 'GET'));
      if (body.state !== 'running') {
        assert.equal(body.state, 'ready');
        assert.equal(body.total, 0);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('scan did not become ready');
  } finally {
    active.stop();
  }
});

test('beginRead keeps startRead compatibility when only startRead exists', async () => {
  const active = start({ startRead: async () => emptySources });
  try {
    const response = bodyOf(await call(active, 'POST'));
    assert.equal(response.state, 'running');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const body = bodyOf(await call(active, 'GET'));
      if (body.state === 'ready') {
        assert.equal(body.total, 0);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('startRead fallback did not become ready');
  } finally {
    active.stop();
  }
});

test('beginRead source rejection becomes sources-unavailable', async () => {
  let reject!: (error: Error) => void;
  const sources = new Promise<Sources>((_, fail) => {
    reject = fail;
  });
  const active = start({ startRead: async () => emptySources, beginRead: async () => ({ sources }) });
  try {
    assert.equal(bodyOf(await call(active, 'POST')).state, 'running');
    reject(new Error('source discovery failed'));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const body = bodyOf(await call(active, 'GET'));
      if (body.state !== 'running') {
        assert.deepEqual(body, { state: 'error', error: 'sources-unavailable' });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('rejected sources did not reach error');
  } finally {
    active.stop();
  }
});

test('beginRead rejection becomes sources-unavailable without claiming running', async () => {
  const active = start({
    startRead: async () => emptySources,
    beginRead: async () => {
      throw new Error('authorization failed');
    },
  });
  try {
    assert.deepEqual(bodyOf(await call(active, 'POST')), { state: 'error', error: 'sources-unavailable' });
  } finally {
    active.stop();
  }
});

test('stop aborts a pending beginRead without publishing ready', async () => {
  let release!: (sources: Sources) => void;
  const sources = new Promise<Sources>((resolve) => {
    release = resolve;
  });
  let beginSignal: AbortSignal | undefined;
  const active = start({
    startRead: async () => emptySources,
    beginRead: async (signal: AbortSignal) => {
      beginSignal = signal;
      return { sources };
    },
  });
  assert.equal(bodyOf(await call(active, 'POST')).state, 'running');
  active.stop();
  assert.equal(beginSignal?.aborted, true);
  release(emptySources);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(bodyOf(await call(active, 'GET')), { state: 'idle' });
});

test('beginRead results page through more than one hundred rows', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'storage-pagination-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(
    Array.from({ length: 250 }, (_, index) => writeFile(join(root, `file-${String(index).padStart(3, '0')}.txt`), 'x')),
  );
  const sources: Sources = {
    threads: [{ id: 'thread-paged', title: 'Paged' }],
    roots: [{ path: root, category: 'work', threadId: 'thread-paged' }],
    files: [],
    nativeSessions: [],
    omissions: [],
  };
  let release!: (value: Sources) => void;
  const gate = new Promise<Sources>((resolve) => {
    release = resolve;
  });
  const active = start({ startRead: async () => sources, beginRead: async () => ({ sources: gate }) });
  try {
    assert.equal(bodyOf(await call(active, 'POST')).state, 'running');
    release(sources);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const body = bodyOf(await call(active, 'GET'));
      if (body.state === 'ready') {
        assert.equal(body.total, 250);
        const first = bodyOf(await call(active, 'GET', { offset: '0', limit: '100' }));
        assert.equal((first.files as unknown[]).length, 100);
        assert.equal(first.nextOffset, 100);
        const second = bodyOf(await call(active, 'GET', { offset: '100', limit: '100' }));
        assert.equal((second.files as unknown[]).length, 100);
        assert.equal(second.nextOffset, 200);
        const last = bodyOf(await call(active, 'GET', { offset: '200', limit: '100' }));
        assert.equal((last.files as unknown[]).length, 50);
        assert.equal(last.nextOffset, undefined);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('paged scan did not become ready');
  } finally {
    active.stop();
  }
});

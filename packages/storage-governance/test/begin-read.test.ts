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

type ReadState =
  | { state: 'running' }
  | { state: 'idle' }
  | { state: 'error' }
  | { state: 'ready'; sources: Sources };

type StorageHost = {
  startRead(): Promise<Sources>;
  beginRead?(): Promise<void>;
  getRead?(): Promise<ReadState>;
};

function start(conversationStorage: StorageHost) {
  return plugin.create().start({ pluginInstanceId: 'fixture', conversationStorage, log: () => {} });
}

function call(active: ReturnType<typeof start>, method: 'GET' | 'POST', query: Record<string, string> = {}) {
  return active.actions['storage-governance.scan'](
    { request: { method, path: 'scan', query } },
    undefined,
    method === 'GET' ? { ...owner, operation: 'read' } : owner,
  );
}

const bodyOf = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;

async function waitForReady(active: ReturnType<typeof start>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const body = bodyOf(await call(active, 'GET'));
    if (body.state !== 'running') return body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('scan did not become ready');
}

test('POST starts beginRead once and GET polls getRead before scanning', async () => {
  let ready = false;
  let beginCalls = 0;
  let getReadCalls = 0;
  const active = start({
    startRead: async () => {
      throw new Error('startRead must not run when the two-step API exists');
    },
    beginRead: async () => {
      beginCalls += 1;
    },
    getRead: async () => {
      getReadCalls += 1;
      return ready ? { state: 'ready', sources: emptySources } : { state: 'running' };
    },
  });
  try {
    const response = await Promise.race([
      call(active, 'POST'),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('POST waited for source discovery')), 500);
        timer.unref();
      }),
    ]);
    assert.deepEqual(bodyOf(response), { state: 'running' });
    assert.equal(beginCalls, 1);
    assert.equal(getReadCalls, 0);

    assert.deepEqual(bodyOf(await call(active, 'GET')), { state: 'running' });
    assert.equal(getReadCalls, 1);

    ready = true;
    assert.deepEqual(bodyOf(await call(active, 'GET')), { state: 'running' });
    assert.equal(getReadCalls, 2);
    const readyBody = await waitForReady(active);
    assert.equal(readyBody.state, 'ready');
    assert.equal(readyBody.total, 0);
    assert.equal(beginCalls, 1);
    assert.equal(getReadCalls, 2);
  } finally {
    active.stop();
  }
});

test('concurrent POSTs call beginRead only once', async () => {
  let beginCalls = 0;
  let getReadCalls = 0;
  const active = start({
    startRead: async () => emptySources,
    beginRead: async () => {
      beginCalls += 1;
    },
    getRead: async () => {
      getReadCalls += 1;
      return { state: 'running' };
    },
  });
  try {
    const [first, second] = await Promise.all([call(active, 'POST'), call(active, 'POST')]);
    assert.deepEqual(bodyOf(first), { state: 'running' });
    assert.deepEqual(bodyOf(second), { state: 'running' });
    assert.equal(beginCalls, 1);
    assert.equal(getReadCalls, 0);
  } finally {
    active.stop();
  }
});

test('concurrent GETs share one getRead call and start one scan', async () => {
  let release!: () => void;
  const readGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let getReadCalls = 0;
  const active = start({
    startRead: async () => emptySources,
    beginRead: async () => {},
    getRead: async () => {
      getReadCalls += 1;
      await readGate;
      return { state: 'ready', sources: emptySources };
    },
  });
  try {
    assert.deepEqual(bodyOf(await call(active, 'POST')), { state: 'running' });
    const first = call(active, 'GET');
    const second = call(active, 'GET');
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    assert.deepEqual(bodyOf(firstResponse), { state: 'running' });
    assert.deepEqual(bodyOf(secondResponse), { state: 'running' });
    assert.equal(getReadCalls, 1);
    const readyBody = await waitForReady(active);
    assert.equal(readyBody.state, 'ready');
    assert.equal(getReadCalls, 1);
  } finally {
    active.stop();
  }
});

test('beginRead keeps startRead compatibility when only startRead exists', async () => {
  const active = start({ startRead: async () => emptySources });
  try {
    const response = bodyOf(await call(active, 'POST'));
    assert.equal(response.state, 'running');
    const readyBody = await waitForReady(active);
    assert.equal(readyBody.state, 'ready');
    assert.equal(readyBody.total, 0);
  } finally {
    active.stop();
  }
});

test('getRead error and beginRead rejection become sources-unavailable', async () => {
  const getReadError = start({
    startRead: async () => emptySources,
    beginRead: async () => {},
    getRead: async () => ({ state: 'error' }),
  });
  try {
    assert.deepEqual(bodyOf(await call(getReadError, 'POST')), { state: 'running' });
    assert.deepEqual(bodyOf(await call(getReadError, 'GET')), { state: 'error', error: 'sources-unavailable' });
  } finally {
    getReadError.stop();
  }

  const beginError = start({
    startRead: async () => emptySources,
    beginRead: async () => {
      throw new Error('authorization failed');
    },
    getRead: async () => ({ state: 'running' }),
  });
  try {
    assert.deepEqual(bodyOf(await call(beginError, 'POST')), { state: 'error', error: 'sources-unavailable' });
  } finally {
    beginError.stop();
  }
});

test('stop aborts a pending two-step read without publishing ready', async () => {
  let getReadCalls = 0;
  const active = start({
    startRead: async () => emptySources,
    beginRead: async () => {},
    getRead: async () => {
      getReadCalls += 1;
      return { state: 'ready', sources: emptySources };
    },
  });
  assert.deepEqual(bodyOf(await call(active, 'POST')), { state: 'running' });
  active.stop();
  assert.deepEqual(bodyOf(await call(active, 'GET')), { state: 'idle' });
  assert.equal(getReadCalls, 0);
});

test('getRead ready results page through more than one hundred rows', async (t) => {
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
  let getReadCalls = 0;
  const active = start({
    startRead: async () => sources,
    beginRead: async () => {},
    getRead: async () => {
      getReadCalls += 1;
      return { state: 'ready', sources };
    },
  });
  try {
    assert.deepEqual(bodyOf(await call(active, 'POST')), { state: 'running' });
    assert.deepEqual(bodyOf(await call(active, 'GET')), { state: 'running' });
    const readyBody = await waitForReady(active);
    assert.equal(readyBody.total, 250);
    assert.equal(getReadCalls, 1);
    const first = bodyOf(await call(active, 'GET', { offset: '0', limit: '100' }));
    assert.equal((first.files as unknown[]).length, 100);
    assert.equal(first.nextOffset, 100);
    const second = bodyOf(await call(active, 'GET', { offset: '100', limit: '100' }));
    assert.equal((second.files as unknown[]).length, 100);
    assert.equal(second.nextOffset, 200);
    const last = bodyOf(await call(active, 'GET', { offset: '200', limit: '100' }));
    assert.equal((last.files as unknown[]).length, 50);
    assert.equal(last.nextOffset, undefined);
  } finally {
    active.stop();
  }
});

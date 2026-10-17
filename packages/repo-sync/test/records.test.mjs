import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Receiver } from '../src/engine.mjs';
import { phase } from '../src/execution.mjs';
import { configSnapshot } from '../src/recording.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { Tasks } from '../src/tasks.mjs';
import { versionRepositories } from './version-fixtures.mjs';

test('private check argument changes have a different configuration identity without exposing arguments', () => {
  const config = { checks: [{ command: 'git', args: ['private-argument-one'] }] };
  const before = configSnapshot(config);
  config.checks[0].args[0] = 'private-argument-two';
  const after = configSnapshot(config);
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.equal(JSON.stringify(after).includes('private-argument'), false);
});

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'repo-sync-history-'));
  const receiver = new Receiver({
    sourceUrl: 'https://github.com/example/core.git',
    internalUrl: 'git@codehub.example:team/core.git',
    internalWebUrl: 'https://web.codehub.example/team/core',
    sourceBranch: 'main',
    targetBranch: 'main',
    mode: 'version',
    internalPaths: ['internal/'],
    mergePaths: [],
    stateDir: folder,
    checks: [{ command: 'git', args: ['fsck', '--no-reflogs'] }],
    checkProfile: 'git-integrity',
  });
  const pair = { upstream: 'a'.repeat(40), internal: 'b'.repeat(40) };
  const deliveries = [1, 2, 3].map((number) => ({
    id: String(number).repeat(24),
    mode: 'version',
    source: { id: `tag-${number}`, tag: `v${number}`, title: `版本 ${number}` },
    target: 'c'.repeat(40),
    base: pair,
    branch: `sync/${number}`,
    status: 'COMPLETE',
    candidate: 'd'.repeat(40),
    acceptedInternal: 'e'.repeat(40),
    commits: ['c'.repeat(40)],
    issues: [],
    issueResults: {},
    checks: { passed: true, head: 'd'.repeat(40) },
    prUrl: `https://web.codehub.example/team/core/pull/${number}`,
  }));
  await receiver.store.save({
    schema: 1,
    bindingId: receiver.config.bindingId,
    mode: 'version',
    initial: pair,
    accepted: pair,
    latest: pair.upstream,
    queue: [],
    events: [],
    issues: {},
    activeId: null,
    deliveries,
  });
  const server = createReceiverServer(receiver);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/status`)).json();
  const get = async (path, authenticated = true) =>
    fetch(base + path, { headers: authenticated ? { 'X-Repo-Sync-Token': token } : {} });
  return { receiver, folder, get, close: () => server.shutdown() };
}

test('history is token protected, paginated and searches all records, with explicit old-data gaps', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.get('/api/records', false)).status, 403);
    const response = await f.get('/api/records?offset=0&limit=2');
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.total, 3);
    assert.equal(page.records.length, 2);
    const searched = await (await f.get('/api/records?q=v1&limit=2')).json();
    assert.equal(searched.total, 1);
    const before = await readFile(f.receiver.store.path, 'utf8');
    const detail = await (await f.get(`/api/records/${'1'.repeat(24)}`)).json();
    assert.equal(detail.delivery.source.tag, 'v1');
    assert.deepEqual(detail.configurations, []);
    assert.equal(detail.legacy, true);
    assert.equal(await readFile(f.receiver.store.path, 'utf8'), before);
    assert.equal((await f.get('/api/records/../../config.json')).status, 404);
    assert.equal((await f.get('/api/records?limit=5000')).status, 409);
    assert.equal((await f.get('/api/records?from=2026-02-31')).status, 409);
    assert.equal((await f.get('/api/records?from=2026-10-14&to=2025-10-14')).status, 409);
  } finally {
    await f.close();
  }
});

test('missing linked tasks remain explicit gaps and paginate without rewriting or inferring attempts', async () => {
  const f = await fixture();
  try {
    const state = await f.receiver.read();
    state.deliveries[0].taskIds = Array.from({ length: 52 }, (_, index) => index.toString(16).padStart(32, '0'));
    await f.receiver.store.save(state);
    const before = await readFile(f.receiver.store.path, 'utf8');
    const path = `/api/records/${'1'.repeat(24)}`;
    const first = await (await f.get(path)).json();
    assert.equal(first.missingTasks.length, 50);
    assert.equal(first.taskPage.hasMore, true);
    assert.deepEqual(first.tasks, []);
    const second = await (await f.get(`${path}?taskOffset=50`)).json();
    assert.equal(second.missingTasks.length, 2);
    assert.equal(second.taskPage.hasMore, false);
    assert.equal(await readFile(f.receiver.store.path, 'utf8'), before);
    state.deliveries[0].recordSchema = 999;
    await f.receiver.store.save(state);
    assert.equal((await f.get(path)).status, 409);
  } finally {
    await f.close();
  }
});

test('tasks retain delivery, phase placement and restricted configuration across restart, without raw arguments', async () => {
  const f = await fixture();
  const id = 'a'.repeat(32);
  const receiver = f.receiver;
  receiver.config.checks = [{ command: 'private-executable', args: ['private-secret-must-not-appear'] }];
  const tasks = new Tasks(
    async () => receiver,
    () => phase('candidate-build', '构造候选', async () => null),
  );
  try {
    await tasks.start({
      action: 'prepare',
      requestId: id,
      deliveryId: '1'.repeat(24),
      expectedBinding: receiver.config.bindingId,
    });
    await tasks.job;
    const stored = JSON.parse(await readFile(join(f.folder, 'operations', `${id}.json`), 'utf8'));
    assert.equal(stored.schema, 2);
    assert.equal(stored.deliveryId, '1'.repeat(24));
    assert.equal(stored.configSnapshot.targetBranch, 'main');
    assert.equal(stored.steps.find((step) => step.key === 'candidate-build').stage, 2);
    assert.equal(JSON.stringify(stored).includes('private-secret-must-not-appear'), false);
    assert.equal(
      (
        await new Tasks(
          async () => receiver,
          () => assert.fail(),
        ).latest(id)
      ).deliveryId,
      stored.deliveryId,
    );
    await receiver.change(async (state) => {
      state.deliveries[0].taskIds = [id];
    });
    const detail = await (await f.get(`/api/records/${'1'.repeat(24)}`)).json();
    assert.equal(detail.tasks.length, 1);
    assert.equal(detail.configurations[0].snapshot.sourceBranch, 'main');
    assert.equal(JSON.stringify(detail).includes('private-executable'), false);
  } finally {
    await f.close();
  }
});

test('unknown task record schemas fail closed instead of becoming legacy history', async () => {
  const f = await fixture();
  const id = 'b'.repeat(32);
  const tasks = new Tasks(
    async () => f.receiver,
    async () => null,
  );
  try {
    await tasks.start({ action: 'heads', requestId: id, expectedBinding: f.receiver.config.bindingId });
    await tasks.job;
    const file = join(f.folder, 'operations', `${id}.json`);
    const value = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...value, schema: 999 }));
    await assert.rejects(
      () =>
        new Tasks(
          async () => f.receiver,
          async () => null,
        ).latest(id),
      { code: 'TASK_UNREADABLE' },
    );
  } finally {
    await f.close();
  }
});

test('new delivery freezes the actual configuration and observation times, not later settings', async () => {
  const f = await versionRepositories();
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.selectTag('v2.0.0');
  await receiver.start();
  const delivery = (await receiver.status()).active;
  assert.equal(delivery.recordSchema, 1);
  assert.equal(delivery.configurations[0].snapshot.sourceBranch, 'releases');
  assert.deepEqual(delivery.configurations[0].snapshot.mergePaths, []);
  assert.ok(delivery.configurations[0].snapshot.internalPaths.includes('README.md'));
  assert.ok(Number.isFinite(Date.parse(delivery.startedAt)));
  receiver.config.internalWebUrl = 'https://different.example/team/core';
  assert.equal((await receiver.status()).active.configurations[0].snapshot.internalWebUrl, undefined);
});

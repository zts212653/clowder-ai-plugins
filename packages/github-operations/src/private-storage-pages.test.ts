import { withIndexedMemoryStorage } from '../test/indexed-memory-storage.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginStorageEntry } from '@clowder-ai/plugin-sdk';
import { GitHubTrackingRuntime, type GitHubSnapshot, type GitHubTrackingProvider } from './tracking-runtime.js';
import { GitHubWaitStorage } from './typed-wait-storage.js';
import type { TaskItem } from './business/model/index.js';
import { SdkCommunityObjectStore } from './business/domains/community/CommunityObjectStore.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { SdkCommunityCollectionStore } from './community-collection.js';

function fixture(pageSize = 2) {
  const rows = new Map<string, PluginStorageEntry>();
  let revision = 0;
  let fullLists = 0;
  const scans: { prefix: string; cursor?: string; count?: number }[] = [];
  const storage = {
    async get(key: string) { return structuredClone(rows.get(key)); },
    async list() { fullLists++; return structuredClone(Object.fromEntries(rows)); },
    async scan(input: { prefix: string; cursor?: string; count?: number }) {
      scans.push(input);
      const selected = [...rows].filter(([key]) => key.startsWith(input.prefix)).sort(([a], [b]) => a.localeCompare(b));
      const start = Number(input.cursor ?? 0);
      const stop = Math.min(selected.length, start + Math.min(input.count ?? pageSize, pageSize));
      return { cursor: stop === selected.length ? '0' : String(stop),
        entries: structuredClone(Object.fromEntries(selected.slice(start, stop))) };
    },
    async set(key: string, value: unknown) {
      rows.set(key, { revision: ++revision, value: structuredClone(value) });
      return { revision };
    },
    async compareAndSet(key: string, expected: number | null, value: unknown) {
      if ((rows.get(key)?.revision ?? null) !== expected) return { applied: false };
      return { applied: true, ...await this.set(key, value) };
    },
    async delete(key: string, expected?: number) {
      const row = rows.get(key);
      if (!row || expected !== undefined && row.revision !== expected) return { deleted: false };
      rows.delete(key); return { deleted: true, revision: ++revision };
    },
  };
  withIndexedMemoryStorage(storage);
  return { storage, rows, scans, fullLists: () => fullLists };
}

const owner = { userId: 'user', catId: 'cat', threadId: 'thread' };
const task: TaskItem = {
  id: 'original-imported-id', kind: 'pr_tracking', subjectKey: 'pr:example/repo#1',
  userId: owner.userId, ownerCatId: owner.catId, threadId: owner.threadId,
  title: 'Original wait', why: '', status: 'doing', createdBy: 'cat', createdAt: 1, updatedAt: 2,
};

test('owner subject lookup pages the wait namespace while retaining legacy IDs and owner separation', async () => {
  const f = fixture();
  await f.storage.set('community.unrelated', { unrelated: 'must not enter wait reads' });
  const store = new GitHubWaitStorage(f.storage);
  await store.create(task);
  await store.create({ ...task, id: 'other-owner', userId: 'another-user' });
  assert.equal((await store.getBySubject(task.subjectKey!, owner))?.id, task.id);
  assert.equal(f.fullLists(), 0, 'one subject must not list the entire private store twice');
  assert.ok(f.scans.length > 0);
  assert.ok(f.scans.every(input => input.prefix === 'github.typed-wait.v1.'));
});

test('paged subject lookup still rejects ambiguous original records rather than choosing a new ID', async () => {
  const f = fixture(); const store = new GitHubWaitStorage(f.storage);
  await store.create(task); await store.create({ ...task, id: 'second-original-id' });
  await assert.rejects(store.getBySubject(task.subjectKey!, owner), /Ambiguous/);
  assert.equal(f.fullLists(), 0);
});

test('an older duplicate scan row cannot resurrect an owner match already observed at a newer revision', async () => {
  const f = fixture(); const store = new GitHubWaitStorage(f.storage);
  await store.create(task);
  const [key, entry] = [...f.rows][0]!;
  const newer = { revision: entry.revision + 1, value: { schemaVersion: 1, task: { ...task, userId: 'other-owner' } } };
  Object.assign(f.storage, { scan: async ({ cursor = '0' }: { cursor?: string }) => cursor === '0'
    ? { cursor: '1', entries: { [key]: newer } }
    : { cursor: '0', entries: { [key]: entry } } });
  assert.equal(await store.getBySubject(task.subjectKey!, owner), null);
});

test('community projections, journal and collection reads request only their own namespaces', async () => {
  const f = fixture();
  await f.storage.set('github.unrelated', { opaque: 'must stay outside these read paths' });
  await f.storage.set('community.object.fixture', { subjectKey: 'issue:example/repo#1' });
  await new SdkCommunityEventLog(f.storage).append({ sourceEventId: 'fixture-event', subjectKey: 'issue:example/repo#1',
    kind: 'issue.opened', classification: 'state-changing', payload: {}, at: 1 });
  assert.deepEqual(await new SdkCommunityObjectStore(f.storage).listSubjectKeys(), ['issue:example/repo#1']);
  assert.equal((await new SdkCommunityEventLog(f.storage).read('issue:example/repo#1')).length, 1);
  assert.deepEqual(await new SdkCommunityCollectionStore(f.storage).listByKind('pr_tracking'), []);
  assert.equal(f.fullLists(), 0, 'Community reads must not each materialize unrelated private namespaces');
});

test('the real GitHub polling entry pages its own records instead of loading community data', async t => {
  const f = fixture();
  await f.storage.set('community.unrelated', { unrelated: 'must not enter the collector' });
  const snapshot: GitHubSnapshot = { state: 'open', comments: [], reviews: [] };
  const runtime = new GitHubTrackingRuntime({
    storage: f.storage, threads: { get: async () => ({ id: 'thread', deepLinkUrl: '/threads/thread',
      title: null, createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [] }) },
    provider: { read: async () => snapshot }, selfLogin: async () => undefined,
    noiseLogins: async () => [], send: async () => ({ messageId: 'unused', threadId: 'thread' }),
  });
  t.after(() => runtime.stop());
  await runtime.register({ kind: 'pr', repoFullName: 'example/repo', number: 1, threadId: 'thread', catId: 'cat' });
  await runtime.poll('cicd-check');
  assert.equal(f.fullLists(), 0, 'background polling must not read the whole private database');
  assert.ok(f.scans.some(input => input.prefix === 'github.tracking.v1.'));
});

test('a partially processed private page survives runtime recreation without starving its remaining targets', async () => {
  const f = fixture(2);
  let now = 0, polling = false;
  const seen: number[] = [];
  const deps = {
    storage: f.storage, threads: { get: async () => ({ id: 'thread', deepLinkUrl: '/threads/thread',
      title: null, createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [] }) },
    provider: { read: async (input: { number: number }): Promise<GitHubSnapshot> => {
      if (polling) { seen.push(input.number); now += 600; }
      return { state: 'open', comments: [], reviews: [] };
    } },
    now: () => now, pollBudgetMs: 2_000,
    selfLogin: async () => undefined, noiseLogins: async () => [],
    send: async () => ({ messageId: 'unused', threadId: 'thread' }),
  };
  const first = new GitHubTrackingRuntime(deps);
  for (const number of [1, 2, 3]) await first.register({ kind: 'pr', repoFullName: 'example/repo',
    number, threadId: 'thread', catId: 'cat' });
  polling = true;
  try { await first.poll('review-feedback'); } finally { await first.stop(); }
  const second = new GitHubTrackingRuntime(deps);
  try { await second.poll('review-feedback'); } finally { await second.stop(); }
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  assert.equal(f.fullLists(), 0);
});

test('a CI scan followed by unregister cannot start a batch from the stale page', async t => {
  const f = fixture();
  const batches: number[][] = [];
  const provider = {
    read: async (): Promise<GitHubSnapshot> => ({ state: 'open', comments: [], reviews: [] }),
    forCiBatch: async (targets: readonly { number: number }[]): Promise<GitHubTrackingProvider> => { batches.push(targets.map(row => row.number)); return provider; },
  };
  const runtime = new GitHubTrackingRuntime({
    storage: f.storage, provider,
    threads: { get: async () => ({ id: 'thread', deepLinkUrl: '/threads/thread', title: null,
      createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [] }) },
    selfLogin: async () => undefined, noiseLogins: async () => [],
    send: async () => ({ messageId: 'unused', threadId: 'thread' }),
  });
  t.after(() => runtime.stop());
  const target = { kind: 'pr' as const, repoFullName: 'example/repo', number: 1, threadId: 'thread', catId: 'cat' };
  await runtime.register(target);
  const scan = f.storage.scan.bind(f.storage);
  Object.assign(f.storage, { scan: async (input: Parameters<typeof scan>[0]) => {
    const page = await scan(input);
    if (input.prefix === 'github.tracking.v1.') await runtime.unregister(target);
    return page;
  } });
  await runtime.poll('cicd-check');
  assert.deepEqual(batches, [], 'revoked HSCAN rows are not authority for a remote CI read');
});

test('a replacement registration supplies the current target to the CI batch', async t => {
  const f = fixture();
  const destinations: string[] = [];
  const provider = {
    read: async (): Promise<GitHubSnapshot> => ({ state: 'open', comments: [], reviews: [] }),
    forCiBatch: async (targets: readonly { threadId: string }[]): Promise<GitHubTrackingProvider> => { destinations.push(...targets.map(row => row.threadId)); return provider; },
  };
  const runtime = new GitHubTrackingRuntime({
    storage: f.storage, provider,
    threads: { get: async id => ({ id, deepLinkUrl: '/threads/' + id, title: null,
      createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [] }) },
    selfLogin: async () => undefined, noiseLogins: async () => [],
    send: async () => ({ messageId: 'unused', threadId: 'thread' }),
  });
  t.after(() => runtime.stop());
  const target = { kind: 'pr' as const, repoFullName: 'example/repo', number: 1, threadId: 'old-thread', catId: 'cat' };
  await runtime.register(target);
  const scan = f.storage.scan.bind(f.storage);
  Object.assign(f.storage, { scan: async (input: Parameters<typeof scan>[0]) => {
    const page = await scan(input);
    if (input.prefix === 'github.tracking.v1.') {
      await runtime.unregister(target);
      await runtime.register({ ...target, threadId: 'current-thread' });
    }
    return page;
  } });
  await runtime.poll('cicd-check');
  assert.deepEqual(destinations, ['current-thread']);
});

test('unregister aborts an in-flight CI batch and waits for its real cleanup', async t => {
  const f = fixture();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  let batchSignal: AbortSignal | undefined;
  const provider = {
    read: async (): Promise<GitHubSnapshot> => ({ state: 'open', comments: [], reviews: [] }),
    forCiBatch: async (_targets: readonly unknown[], signal: AbortSignal): Promise<GitHubTrackingProvider> => {
      batchSignal = signal;
      entered();
      await new Promise<void>(resolve => { release = resolve; });
      return provider;
    },
  };
  const runtime = new GitHubTrackingRuntime({
    storage: f.storage, provider,
    threads: { get: async () => ({ id: 'thread', deepLinkUrl: '/threads/thread', title: null,
      createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [] }) },
    selfLogin: async () => undefined, noiseLogins: async () => [],
    send: async () => ({ messageId: 'unused', threadId: 'thread' }),
  });
  t.after(() => runtime.stop());
  const target = { kind: 'pr' as const, repoFullName: 'example/repo', number: 1, threadId: 'thread', catId: 'cat' };
  await runtime.register(target);
  const pending = runtime.poll('cicd-check');
  let completed = false;
  const settled = pending.then(() => { completed = true; }, error => { completed = true; return error; });
  try {
    await started;
    await runtime.unregister(target);
    assert.equal(batchSignal?.aborted, true, 'unregister must cover the batch before per-target polling starts');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(completed, false, 'poll must retain the real provider child until cleanup completes');
  } finally {
    release();
    await settled;
  }
});

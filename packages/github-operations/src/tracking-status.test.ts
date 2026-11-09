import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';
import type { ModulePluginHostShape, PluginActionContext } from '@clowder-ai/plugin-sdk';
import { memoryStorage } from '../test/memory-storage.js';
import { createGitHubPluginModule } from './plugin-entrypoint.js';
import { waitKey } from './typed-wait-record.js';
import { collectionId, collectionKey } from './community-collection-record.js';
import { migratedIssueKey } from './migrated-issue-record.js';
import { SUBJECTS, JOURNAL_HEAD, eventKey } from './business/domains/community/journal-directory.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));
const caller: PluginActionContext = { userId: 'owner', catId: 'cat-1', threadId: 'thread-1',
  invocationId: 'isolated-invocation', assertCurrent: async () => {} };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const storage = memoryStorage(); let providerReads = 0;
  let scan = storage.scan!.bind(storage);
  storage.scan = input => scan(input);
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected external operation'); };
  const host = { pluginInstanceId: 'isolated-status', dataPath: '/unused-in-memory', storage,
    config: { get: async () => undefined }, secrets: { get: async () => 'isolated-secret' },
    tasks: { get: async () => null, list: async () => [], create: unexpected, update: unexpected },
    members: { list: async () => [], get: async () => null },
    threads: { get: async () => null, list: async () => [], readMessages: unexpected, getCats: unexpected,
      create: unexpected, update: unexpected, addParticipants: unexpected },
    messaging: { send: unexpected }, streams: { read: unexpected }, log: () => {} } as unknown as ModulePluginHostShape;
  const active = await createGitHubPluginModule({ pollIntervalMs: 0,
    createProvider: () => ({ read: async () => { providerReads++; return unexpected(); }, selfLogin: () => undefined }),
  }).create(manifest).start(host);
  t.after(async () => { await active.stop({ reason: 'test' }); });
  const call = async (input: unknown = {}, actor = caller) => (await active.actions['github.tracking.list']!(input, actor)) as any;
  return { storage, call, providerReads: () => providerReads,
    setScan: (next: NonNullable<typeof storage.scan>) => { scan = next; } };
}

function record(i: number, longHistory = false) {
  const task = { id: `subscription-${i}`, kind: i % 2 ? 'pr_tracking' : 'issue_tracking',
    subjectKey: `${i % 2 ? 'pr' : 'issue'}:example/project-${i % 3}#${i + 1}`, userId: 'owner',
    ownerCatId: `cat-${i % 4}`, threadId: `thread-${i % 5}`, title: `Synthetic subscription ${i}`,
    why: '', status: 'doing', createdBy: 'system', createdAt: 1, updatedAt: 1,
    automationState: { await: { generation: 7, baseline: { headSha: 'a'.repeat(40) }, nextStep: 'Resume original wait' } } };
  const notices = Object.fromEntries(Array.from({ length: longHistory ? 100 : 0 }, (_, j) => [`notice-${j}`,
    { key: `notice-${j}`, scope: 'old-scope', userId: 'owner', threadId: task.threadId,
      taskId: task.id, failures: 0, nextAt: j, state: 'delivered' }]));
  return { schemaVersion: 1, task, recovery: { v: 1, scope: hash(task.id), revision: 9,
    index: i % 2 ? 'github-pr-waits' : 'github-issue-waits', nextPollAt: 1, failures: 5,
    disposition: 'needs_attention', reasonCode: 'github_observation_failed', notices } };
}

test('real list action bounds/filter pages without changing original waits or returning retained notice logs', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 300; i++) { const row = record(i, true); await f.storage.set(waitKey(row.task.id), row); }
  const before = JSON.stringify(await f.storage.list());
  const query = { repo: 'Example/PROJECT-1', catId: 'cat-1', limit: 5 };
  const seen = new Set<string>(); let cursor: string | undefined; let pages = 0; let largest = 0;
  do {
    const result = await f.call({ ...query, ...(cursor ? { cursor } : {}) });
    assert.ok(result.data.tracking.length <= 5, 'requested page must not expand the installation');
    assert.equal(result.data.page.returned, result.data.tracking.length);
    assert.equal(result.data.page.remaining, null, 'a bounded scan cannot invent an exact remaining total');
    largest = Math.max(largest, Buffer.byteLength(JSON.stringify(result)));
    for (const task of result.data.tracking) {
      assert.match(task.subjectKey, /:example\/project-1#/); assert.equal(task.ownerCatId, 'cat-1');
      assert.equal(task.automationState.await.generation, 7);
      assert.ok(!seen.has(task.id), 'static pages must not repeat or skip the oversized scan tail'); seen.add(task.id);
      const recovery = result.data.recoveryOwners.typed.find((r: any) => r.taskId === task.id);
      assert.equal(recovery.recovery.scope, hash(task.id)); assert.equal(recovery.recovery.revision, 9);
      assert.equal(recovery.recovery.notices, undefined);
      assert.equal(recovery.recovery.noticeSummary.total, 100);
    }
    cursor = result.data.page.nextCursor ?? undefined;
    assert.equal(result.data.page.hasMore, !!cursor); assert.ok(++pages < 100);
  } while (cursor);
  assert.equal(seen.size, 25); assert.ok(largest <= 65_536);
  t.diagnostic(JSON.stringify({ matchedSubscriptions: seen.size, pages, largestResponseBytes: largest }));
  assert.equal(JSON.stringify(await f.storage.list()), before); assert.equal(f.providerReads(), 0);
});

test('empty nonterminal and oversized storage pages remain continuable, with bounded work and honest unknown ownership', async t => {
  const f = await fixture(t); const first = record(1), second = record(13);
  await f.storage.set(waitKey(first.task.id), first); await f.storage.set(waitKey(second.task.id), second);
  const all = await f.storage.list(); let calls = 0;
  f.setScan(async ({ prefix, cursor = '0' }) => {
    calls++;
    if (prefix !== 'github.typed-wait.v1.') return { cursor: '0', entries: {} };
    if (cursor === '0') return { cursor: '17', entries: {} };
    return { cursor: '0', entries: Object.fromEntries(Object.entries(all).filter(([key]) => key.startsWith(prefix))) };
  });
  const a = await f.call({ limit: 1 }); assert.equal(a.data.tracking.length, 1); assert.ok(a.data.page.nextCursor);
  const b = await f.call({ limit: 1, cursor: a.data.page.nextCursor });
  assert.equal(b.data.tracking.length, 1); assert.notEqual(a.data.tracking[0].id, b.data.tracking[0].id);
  assert.equal(b.data.page.nextCursor, null); assert.ok(calls <= 5);
  f.setScan(async () => { calls++; return { cursor: String(calls + 1), entries: {} }; });
  const empty = await f.call({ repo: 'absent/repo' });
  assert.equal(empty.data.tracking.length, 0); assert.equal(empty.data.page.hasMore, true);
  assert.equal(empty.data.page.stopReason, 'scan_budget'); assert.ok(empty.data.page.scanCalls <= 8);
});

test('recovery/diagnostic views retain actionable identities while bounding large rows and rejecting changed query cursors', async t => {
  const f = await fixture(t); const row = record(1, true);
  Object.assign(row.task.automationState, { historicPayload: 'x'.repeat(300_000) });
  Object.assign(row.recovery, { lastError: { name: 'ProviderError', message: 'failed with isolated-secret', stderr: 'x'.repeat(100_000) } });
  await f.storage.set(waitKey(row.task.id), row);
  const other = record(13); await f.storage.set(waitKey(other.task.id), other);
  const foreign = record(2); foreign.task.userId = 'another-user';
  await f.storage.set(waitKey(foreign.task.id), foreign);
  await f.storage.set('github.tracking-diagnostics.v1.' + hash('diagnostic'), {
    requestKey: hash('diagnostic'), subject: row.task.subjectKey, catId: row.task.ownerCatId, threadId: row.task.threadId,
    at: 1, attempts: 1, phase: 'read_github', status: 'failed', code: 'provider_read_failed',
    error: { name: 'ProviderError', message: 'failed with isolated-secret', stack: 'x'.repeat(100_000) },
  });
  const before = JSON.stringify(await f.storage.list());
  const owned = await f.call({ view: 'recovery' });
  assert.equal(owned.data.tracking.length, 2);
  assert.ok(owned.data.tracking.every((task: any) => task.userId === caller.userId));
  assert.ok(owned.data.recoveryOwners.typed.every((item: any) => item.taskId !== foreign.task.id));
  const result = await f.call({ view: 'recovery', needsAttention: true, limit: 1 });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65_536);
  assert.ok(!JSON.stringify(result).includes('isolated-secret'));
  assert.equal(result.data.tracking[0].automationState.await.generation, 7);
  assert.ok(result.data.tracking[0].omittedFields.includes('automationState'));
  assert.equal(result.data.recoveryOwners.typed[0].recovery.scope, hash(result.data.tracking[0].id));
  const diag = await f.call({ view: 'diagnostics', repo: 'example/project-1' });
  assert.equal(diag.data.diagnostics.length, 1); assert.ok(!JSON.stringify(diag).includes('isolated-secret'));
  assert.equal(diag.data.tracking.length, 0); assert.ok(Buffer.byteLength(JSON.stringify(diag)) <= 65_536);
  const cursor = result.data.page.nextCursor;
  assert.ok(cursor); await assert.rejects(f.call({ view: 'recovery', needsAttention: true, limit: 2, cursor }), /cursor/i);
  for (const invalid of [{ limit: 0 }, { limit: 51 }, { repo: '*/*' }, { cursor: 'broken' }, { userId: 'another-user' }])
    await assert.rejects(f.call(invalid));
  assert.equal(JSON.stringify(await f.storage.list()), before);
});

test('all recovery owners page together, retain scope/revision and original routes, and disclose unattributed records', async t => {
  const f = await fixture(t), row = record(1);
  await f.storage.set(waitKey(row.task.id), row);
  const subject = row.task.subjectKey;
  await f.storage.set(collectionKey(collectionId(subject)), { ...row,
    task: { ...row.task, id: collectionId(subject), automationState: {} } });
  await f.storage.set(migratedIssueKey('old-issue'), { ...row, sourceUpdatedAt: 1,
    task: { ...row.task, id: 'old-issue', kind: 'issue_tracking', automationState: { issue: { lastDeliveredCursor: 24 } } } });
  await f.storage.set(SUBJECTS + hash(subject), { v: 1, subject, ownerThread: 'thread-1',
    route: { sequence: 0, sourceEventId: 'original-route' }, recovery: row.recovery });
  await f.storage.set(eventKey('original-route'), { sequence: 0, subjectSequence: 0, event: {
    sourceEventId: 'original-route', subjectKey: subject, kind: 'case.routed',
    payload: { userId: 'owner', catId: 'cat-1', ownerThreadId: 'thread-1' } } });
  await f.storage.set(JOURNAL_HEAD, { directory: { status: 'ready' } });
  await f.storage.set('community.collection.v1.' + hash('unattributed'), { disposition: 'needs_attention',
    reasonCode: 'invalid_collection_source', _collectionRecoveryCorruption: { privateHistory: 'never returned' } });
  const before = JSON.stringify(await f.storage.list());
  const scoped = await f.call({ view: 'recovery', repo: 'example/project-1', catId: 'cat-1', threadId: 'thread-1', needsAttention: true });
  for (const rows of [scoped.data.recoveryOwners.typed, scoped.data.recoveryOwners.collection,
    scoped.data.recoveryOwners.migratedIssues, scoped.data.recoveryOwners.journal.entries]) {
    assert.equal(rows.length, 1); assert.equal(rows[0].recovery.scope, row.recovery.scope);
    assert.equal(rows[0].recovery.revision, 9);
  }
  assert.equal(scoped.data.page.unattributed, 1);
  assert.equal(scoped.data.recoveryOwners.journal.readiness, 'ready');
  assert.equal(scoped.data.tracking.find((r: any) => r.id === 'old-issue').automationState.issue.lastDeliveredCursor, 24);
  const unscoped = await f.call({ view: 'recovery', needsAttention: true });
  assert.equal(unscoped.data.recoveryOwners.collection.length, 2);
  assert.ok(!JSON.stringify(unscoped).includes('never returned'));
  assert.equal(JSON.stringify(await f.storage.list()), before); assert.equal(f.providerReads(), 0);
});

test('byte budget advances before an oversized page and native authority revocation rejects a late result', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 50; i++) {
    const row = record(i); Object.assign(row.task.automationState, { detail: 'x'.repeat(6500) });
    await f.storage.set(waitKey(row.task.id), row);
  }
  const first = await f.call({ limit: 50 });
  assert.equal(first.data.page.stopReason, 'byte_budget'); assert.ok(first.data.page.nextCursor);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 65_536);
  const next = await f.call({ limit: 50, cursor: first.data.page.nextCursor });
  const seen = new Set(first.data.tracking.map((r: any) => r.id));
  assert.ok(next.data.tracking.every((r: any) => !seen.has(r.id)));
  let revoked = false;
  // Use an independent raw scan so the indirection does not recurse.
  const snapshot = await f.storage.list();
  f.setScan(async ({ prefix }) => { revoked = true; return { cursor: '0',
    entries: Object.fromEntries(Object.entries(snapshot).filter(([key]) => key.startsWith(prefix))) }; });
  await assert.rejects(f.call({}, { ...caller, assertCurrent: async () => { if (revoked) throw new Error('authority revoked'); } }), /authority revoked/);
});

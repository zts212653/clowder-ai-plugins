import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryStorage } from '../test/memory-storage.js';
import { SdkCommunityPrStore } from './business/domains/community/CommunityWorkflowStores.js';
import { GitHubPrTitleReader } from './pr-title-reader.js';

const target = { kind: 'pr', repoFullName: 'org/repo', number: 12, threadId: 'thread', catId: 'codex' } as const;
const snapshot = (title: string, at: number) => ({
  title, observedAt: at, providerUpdatedAt: new Date(at).toISOString(),
  authorLogin: 'author', headSha: 'a'.repeat(40), draft: false,
  state: 'open' as const, comments: [], reviews: [],
});

test('a delayed background response preserves a newer same-HEAD title and cached reads follow the original record', async t => {
  const storage = memoryStorage();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const reader = new GitHubPrTitleReader({
    records: new SdkCommunityPrStore(storage), now: () => 1000, token: async () => undefined,
    execFileAsync: async () => {
      calls++; entered(); await gate;
      return { stdout: JSON.stringify({ number: 12, repository: 'org/repo', title: 'Old title',
        author: 'author', state: 'open', mergedAt: null, headSha: 'a'.repeat(40), draft: false,
        updatedAt: new Date(1000).toISOString() }) };
    },
  });
  t.after(() => reader.stop());
  t.after(() => release());
  const pending = reader.read('org/repo#12');
  await started;
  await reader.observe(target, snapshot('New title', 2000));
  assert.equal(await reader.readLocal('org/repo#12'), 'New title');
  release();
  assert.equal(await pending, 'New title');
  await reader.observe(target, snapshot('Newest title', 3000));
  assert.equal(await reader.read('org/repo#12'), 'Newest title');
  assert.equal(calls, 1, 'a fresh cached background read does not query GitHub again');
  assert.equal((await new SdkCommunityPrStore(storage).getByRepoAndNumber('org/repo', 12))?.title, 'Newest title');
});

test('an older same-HEAD observation cannot roll back a persisted rename after reader/store recreation', async t => {
  const storage = memoryStorage();
  const records = new SdkCommunityPrStore(storage);
  const reader = new GitHubPrTitleReader({ records, token: async () => undefined });
  t.after(() => reader.stop());
  await reader.observe(target, snapshot('New title', 2000));
  const record = await records.getByRepoAndNumber('org/repo', 12);
  assert.ok(record);
  await records.update(record.id, { replyState: 'replied', lastReviewedSha: record.headSha });
  const restored = new GitHubPrTitleReader({ records: new SdkCommunityPrStore(storage), token: async () => undefined });
  t.after(() => restored.stop());
  await restored.observe(target, { ...snapshot('Old title', 1000), observedAt: 3000 });
  assert.equal(await restored.readLocal('org/repo#12'), 'New title');
  const current = await records.get(record.id);
  assert.equal(current?.headSha, 'a'.repeat(40));
  assert.equal(current?.replyState, 'replied');
  assert.equal(current?.lastReviewedSha, record.headSha);
  await restored.observe(target, { ...snapshot('Newer provider revision', 4000), observedAt: 500 });
  assert.equal(await restored.readLocal('org/repo#12'), 'Newer provider revision');
});

test('equal provider dates use request start ordering and an exact duplicate cannot replace the accepted title', async t => {
  const reader = new GitHubPrTitleReader({ records: new SdkCommunityPrStore(memoryStorage()), token: async () => undefined });
  t.after(() => reader.stop());
  await reader.observe(target, { ...snapshot('Accepted title', 1000), observedAt: 2000 });
  await reader.observe(target, { ...snapshot('Older request', 1000), observedAt: 1000 });
  await reader.observe(target, { ...snapshot('Conflicting duplicate', 1000), observedAt: 2000 });
  assert.equal(await reader.readLocal('org/repo#12'), 'Accepted title');
  await reader.observe(target, { ...snapshot('Later request', 1000), observedAt: 3000 });
  assert.equal(await reader.readLocal('org/repo#12'), 'Later request');
});

test('competing cold creates from independent readers retain the newer title instead of dropping the losing write', async t => {
  const storage = memoryStorage();
  const older = new GitHubPrTitleReader({ records: new SdkCommunityPrStore(storage), token: async () => undefined });
  const newer = new GitHubPrTitleReader({ records: new SdkCommunityPrStore(storage), token: async () => undefined });
  t.after(() => older.stop());
  t.after(() => newer.stop());
  await Promise.all([older.observe(target, snapshot('Old title', 1000)), newer.observe(target, snapshot('New title', 2000))]);
  const restored = new GitHubPrTitleReader({ records: new SdkCommunityPrStore(storage), token: async () => undefined });
  t.after(() => restored.stop());
  assert.equal(await restored.readLocal('org/repo#12'), 'New title');
});

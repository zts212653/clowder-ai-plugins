import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { memoryStorage } from '../test/memory-storage.js';
import { copyLegacyRepositoryProgress, restoreLegacyRepositoryProgress, legacyRepositorySnapshotBytes, communityProgressKey } from './legacy-repository-progress.js';

const repo = 'example/project';
const raw = () => ({ [`f141:baseline:${repo}`]: '1', [`f141:notified:${repo}#issue-7`]: '1',
  [`community:repo-comment:cursor:${repo}`]: '2026-10-08T10:00:00.000Z' });
const signal = () => new AbortController().signal;
function envelope(repositories: Record<string, Record<string, string>>) {
  return { protocolVersion: 1, snapshot: { repositories },
    sourceDigest: createHash('sha256').update(legacyRepositorySnapshotBytes(repositories)).digest('hex') };
}

test('repository progress import stages inert records and restores only missing progress after explicit registration', async () => {
  const storage = memoryStorage(), input = envelope({ [repo]: raw() });
  assert.equal((await copyLegacyRepositoryProgress(input, storage, signal())).data.imported, 1);
  const staged = await storage.list();
  assert.ok(Object.keys(staged).every(key => key.startsWith('community.legacy-repo.')));
  assert.equal((await copyLegacyRepositoryProgress(input, storage, signal())).data.identical, 1);
  await restoreLegacyRepositoryProgress(repo, storage, signal());
  assert.equal((await storage.get(communityProgressKey('scan-baseline', repo)))?.value, true);
  assert.equal((await storage.get(communityProgressKey('scan-notified', `issue:${repo}#7`)))?.value, true);
  const key = communityProgressKey('comment-cursor', repo);
  await storage.set(key, '2026-10-09T00:00:00.000Z');
  await restoreLegacyRepositoryProgress(repo, storage, signal());
  assert.equal((await storage.get(key))?.value, '2026-10-09T00:00:00.000Z', 'owner/runtime progress never rolls back');
});

test('all raw records are prevalidated; foreign keys, malformed values, case aliases and digest mismatch write nothing', async () => {
  const storage = memoryStorage();
  const invalid: Array<Record<string, Record<string, string>>> = [
    { [repo]: { ...raw(), 'f141:notified:foreign/repo#issue-1': '1' } },
    { [repo]: { ...raw(), [`f141:baseline:${repo}`]: '0' } },
    { [repo]: { ...raw(), [`f141:notified:${repo}#issue-01`]: '1' } },
    { [repo]: { ...raw(), [`community:repo-comment:cursor:${repo}`]: 'yesterday' } },
    { [repo]: raw(), 'EXAMPLE/PROJECT': raw() },
    { [repo]: raw(), 'other/repo': { 'guardianAssignment': 'token' } },
  ];
  for (const repositories of invalid) await assert.rejects(copyLegacyRepositoryProgress(envelope(repositories), storage, signal()));
  await assert.rejects(copyLegacyRepositoryProgress({ ...envelope({ [repo]: raw() }), sourceDigest: '0'.repeat(64) }, storage, signal()));
  assert.deepEqual(await storage.list(), {});
});

test('insert-only copies preserve active configs, retry partial failures, reject corrupt staging and observe abort', async () => {
  const storage = memoryStorage();
  const activeKey = 'community.repo.' + createHash('sha256').update(repo).digest('hex');
  await storage.set(activeKey, { repo });
  assert.equal((await copyLegacyRepositoryProgress(envelope({ [repo]: raw() }), storage, signal())).data.preserved, 1);
  assert.equal(Object.keys(await storage.list()).length, 1);
  await storage.delete(activeKey);
  const input = envelope({ [repo]: raw(), 'other/repo': {} });
  const cas = storage.compareAndSet; let n = 0;
  storage.compareAndSet = async (...args) => { if (++n === 2) throw new Error('disk'); return cas(...args); };
  await assert.rejects(copyLegacyRepositoryProgress(input, storage, signal()), /disk/);
  storage.compareAndSet = cas;
  assert.equal((await copyLegacyRepositoryProgress(input, storage, signal())).data.imported, 1);
  const stage = Object.keys(await storage.list()).find(key => key.endsWith(createHash('sha256').update(repo).digest('hex')))!;
  await storage.set(stage, { schemaVersion: 1, repo, strings: { authority: 'bad' } });
  await assert.rejects(restoreLegacyRepositoryProgress(repo, storage, signal()), /unsupported/);
  const controller = new AbortController(); controller.abort(new Error('stopped'));
  await assert.rejects(copyLegacyRepositoryProgress(input, storage, controller.signal), /stopped/);
});

test('envelope and record budgets apply before any copy', async () => {
  const storage = memoryStorage();
  const many = Object.fromEntries(Array.from({ length: 51 }, (_, n) => [`owner/repo${n}`, {}]));
  await assert.rejects(copyLegacyRepositoryProgress(envelope(many), storage, signal()), /50 repositories/);
  await assert.rejects(copyLegacyRepositoryProgress(envelope({ [repo]: { ...raw(), huge: 'x'.repeat(256 * 1024) } }), storage, signal()), /256 KiB/);
  assert.deepEqual(await storage.list(), {});
});

test('failed restore retries missing keys without overwriting progressed cursors; concurrent staging inserts once', async () => {
  const storage = memoryStorage(), input = envelope({ [repo]: raw() });
  const copies = await Promise.all([copyLegacyRepositoryProgress(input, storage, signal()), copyLegacyRepositoryProgress(input, storage, signal())]);
  assert.equal(copies.reduce((sum, c) => sum + c.data.imported, 0), 1);
  const cas = storage.compareAndSet; let n = 0;
  storage.compareAndSet = async (...args) => { if (++n === 2) throw new Error('restore disk'); return cas(...args); };
  await assert.rejects(restoreLegacyRepositoryProgress(repo, storage, signal()), /restore disk/);
  assert.equal(await storage.get(communityProgressKey('repo', repo)), undefined, 'partial restore cannot enable polling');
  storage.compareAndSet = cas;
  await storage.set(communityProgressKey('comment-cursor', repo), '2026-10-09T00:00:00.000Z');
  await restoreLegacyRepositoryProgress(repo, storage, signal());
  assert.equal((await storage.get(communityProgressKey('scan-baseline', repo)))?.value, true);
  assert.equal((await storage.get(communityProgressKey('comment-cursor', repo)))?.value, '2026-10-09T00:00:00.000Z');
});

test('5001 notifications are rejected even with valid digest and no config is restored from a snapshot', async () => {
  const storage = memoryStorage();
  const notifications = Object.fromEntries(Array.from({ length: 5001 }, (_, n) => [`f141:notified:a/b#pr-${n + 1}`, '1']));
  await assert.rejects(copyLegacyRepositoryProgress(envelope({ 'a/b': notifications }), storage, signal()), /5000 notifications/);
  assert.deepEqual(await storage.list(), {});
  await assert.rejects(copyLegacyRepositoryProgress(envelope({ [repo]: { guardThreadId: 'claimed-thread' } }), storage, signal()), /unsupported/);
});

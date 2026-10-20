import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { memoryStorage } from '../test/memory-storage.js';
import { SdkCommunityIssueStore } from './business/domains/community/CommunityIssueStore.js';
import { copyLegacyIssueObservations, legacyIssueSnapshotBytes } from './legacy-issue-observations.js';

const raw = (id: string, issueNumber: string) => ({ id, repo: 'example/project', issueNumber, issueType: 'bug', title: `Issue ${issueNumber}`,
  linkedPrNumbers: '[4]', createdAt: '10', updatedAt: '20', state: 'accepted', guardianAssignment: 'not parsed: private authority',
  assignedThreadId: 'private-thread', assignedCatId: 'private-cat', routeAcceptance: 'accepted', directionCard: 'private notes' });
function envelope(issues: Record<string, Record<string, string>>) {
  return { protocolVersion: 1, sourceDigest: createHash('sha256').update(legacyIssueSnapshotBytes(issues)).digest('hex'), snapshot: { issues } };
}
const signal = () => new AbortController().signal;

test('raw canonicalization uses code-unit ordering even for numeric-looking IDs and never parses string values', () => {
  const issues = JSON.parse('{"2":{"title":"[2,1]","id":"2"},"10":{"id":"10","title":" [] "}}');
  assert.equal(legacyIssueSnapshotBytes(issues), '{"issues":{"10":{"id":"10","title":" [] "},"2":{"id":"2","title":"[2,1]"}}}');
  assert.equal(legacyIssueSnapshotBytes({ '10': issues['10'], '2': issues['2'] }), legacyIssueSnapshotBytes(issues));
});

test('copy validates all records before mutation and never uses payload governance as authority', async () => {
  const storage = memoryStorage(), store = new SdkCommunityIssueStore(storage);
  for (const value of [
    envelope({ one: raw('one', '1'), two: { ...raw('two', '2'), issueNumber: '2.1' } }),
    envelope({ one: { ...raw('one', '1'), linkedPrNumbers: '["4"]' } }),
    envelope({ one: { ...raw('one', '1'), title: '' } }),
    envelope({ one: { ...raw('one', '1'), createdAt: '-1' } }),
    envelope({ one: { ...raw('one', '1'), updatedAt: '9007199254740992' } }),
    envelope({ one: { ...raw('one', '1'), privilegedNewField: 'must not guess its meaning' } }),
    envelope({ one: raw('wrong-id', '1') }),
    envelope({ one: raw('one', '1'), two: { ...raw('two', '1'), repo: 'EXAMPLE/PROJECT' } }),
    { ...envelope({ one: raw('one', '1') }), sourceDigest: '0'.repeat(64) },
    { ...envelope({ one: raw('one', '1') }), userId: 'claimed-owner' },
  ]) {
    await assert.rejects(copyLegacyIssueObservations(value, store, signal()));
    assert.deepEqual(await storage.list(), {}, 'invalid batch cannot leave a partially copied first row');
  }
  const input = envelope({ one: raw('one', '1') }), savedInput = structuredClone(input);
  const receipt = await copyLegacyIssueObservations(input, store, signal());
  assert.equal(receipt.data.imported, 1);
  assert.deepEqual(input, savedInput);
  assert.doesNotMatch(JSON.stringify(await storage.list()), /private|guardian|assigned|routeAcceptance|accepted|directionCard/);
  assert.doesNotMatch(JSON.stringify(receipt), /private|Issue 1|example\/project/);
});

test('copy is insert-only across concurrency, owner edits and replay after a partial storage failure', async () => {
  const storage = memoryStorage(), store = new SdkCommunityIssueStore(storage);
  const input = envelope({ one: raw('one', '1'), two: raw('two', '2') });
  const cas = storage.compareAndSet;
  let writes = 0;
  storage.compareAndSet = async (key, revision, value) => {
    if (++writes === 2) throw new Error('isolated disk failure');
    return cas(key, revision, value);
  };
  await assert.rejects(copyLegacyIssueObservations(input, store, signal()), /disk failure/);
  assert.equal((await store.listAll()).length, 1);
  storage.compareAndSet = cas;
  const receipts = await Promise.all([copyLegacyIssueObservations(input, store, signal()), copyLegacyIssueObservations(input, new SdkCommunityIssueStore(storage), signal())]);
  assert.equal(receipts.reduce((sum, result) => sum + result.data.imported, 0), 1);
  assert.equal((await store.listAll()).length, 2);
  const first = (await store.getByRepoAndNumber('example/project', 1))!;
  await store.update(first.id, { title: 'Owner changed title', linkedPrNumbers: [8] });
  const retried = await copyLegacyIssueObservations(input, new SdkCommunityIssueStore(storage), signal());
  assert.equal(retried.data.preserved, 1);
  assert.equal(retried.data.identical, 1);
  assert.equal((await store.get(first.id))?.title, 'Owner changed title');
  assert.deepEqual((await store.get(first.id))?.linkedPrNumbers, [8]);
});

test('bounded copy checks envelope bytes, record count, abort and corrupt existing records', async () => {
  const storage = memoryStorage(), store = new SdkCommunityIssueStore(storage);
  await assert.rejects(copyLegacyIssueObservations(envelope({ one: { ...raw('one', '1'), directionCard: 'x'.repeat(256 * 1024) } }), store, signal()), /256 KiB/);
  const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [String(i), raw(String(i), String(i + 1))]));
  await assert.rejects(copyLegacyIssueObservations(envelope(many), store, signal()), /500 records/);
  const controller = new AbortController(); controller.abort(new Error('disabled'));
  const input = envelope({ one: raw('one', '1') });
  await assert.rejects(copyLegacyIssueObservations(input, store, controller.signal), /disabled/);
  assert.deepEqual(await storage.list(), {});
  await copyLegacyIssueObservations(input, store, signal());
  const current = (await store.getByRepoAndNumber('example/project', 1))!;
  await storage.set(`community.issue.${current.id}`, { ...current, guardianAssignment: { token: 'foreign-authority' } });
  const corrupt = await storage.list();
  await assert.rejects(copyLegacyIssueObservations(input, store, signal()), /unsupported/);
  assert.deepEqual(await storage.list(), corrupt, 'corrupt existing state is never silently replaced by import');
});

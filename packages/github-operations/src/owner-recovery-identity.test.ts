import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryStorage } from '../test/memory-storage.js';
import { SdkCommunityCollectionStore } from './community-collection.js';
import { collectionId, collectionKey, collectionPrefix, collectionIndex, collectionIndexOwner } from './community-collection-record.js';
import { migratedIssueKey, migratedIssueIndexOwner, MIGRATED_ISSUE_INDEX } from './migrated-issue-record.js';
import type { TaskItem } from './business/model/index.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { SUBJECTS, hash, journalIndex } from './business/domains/community/journal-directory.js';

function row(number: number) {
  const subjectKey = `issue:owner/repo#${number}`;
  const task: TaskItem = { id: collectionId(subjectKey), kind: 'issue_tracking', subjectKey,
    status: 'doing', title: 'Retained original', why: '', createdBy: 'system', createdAt: 1, updatedAt: 1,
    userId: 'owner', threadId: 'home', ownerCatId: 'cat' };
  return { schemaVersion: 1 as const, task };
}

test('collection census retires miskeyed history at the original key and rebuild never revives it', async () => {
  const storage = memoryStorage(), store = new SdkCommunityCollectionStore(storage, () => 1000);
  const wrong = collectionPrefix + '0'.repeat(64), original = row(1), good = row(2);
  await storage.set(wrong, original); await storage.set(collectionKey(good.task.id), good);
  await store.initialize();
  assert.deepEqual((await store.due('issue')).map(r => r.task.id), [good.task.id]);
  const parked = (await storage.get(wrong))!.value as { disposition: string; _collectionRecoveryCorruption: unknown };
  assert.equal(parked.disposition, 'needs_attention'); assert.deepEqual(parked._collectionRecoveryCorruption, original);
  await store.initialize(true);
  assert.deepEqual((await store.due('issue')).map(r => r.task.id), [good.task.id]);
  assert.equal(await storage.get(collectionKey(original.task.id)), undefined, 'never invent a corrected original ID');
});

test('collection due validates new malformed entries by exact source revision, and a concurrent repair wins', async () => {
  const storage = memoryStorage(), store = new SdkCommunityCollectionStore(storage, () => 1000);
  const owner = collectionIndexOwner(storage);
  await store.initialize();
  const original = row(1), wrong = collectionKey(row(2).task.id), repaired = row(2);
  await storage.compareAndSetIndexed!(wrong, null, original, { index: collectionIndex('issue'), score: 0 });
  const publish = storage.compareAndSetIndexed!;
  let repair = true;
  storage.compareAndSetIndexed = async (...args) => {
    if (args[0] === wrong && repair) {
      repair = false; await owner.publish(wrong, args[1], repaired);
    }
    return publish(...args);
  };
  await store.due('issue');
  assert.equal(repair, false, 'the original selected key must reach its quarantine CAS');
  const after = (await storage.get(wrong))!.value as { task: TaskItem; disposition?: unknown };
  assert.equal(after.task.id, repaired.task.id); assert.equal(after.disposition, undefined);
  assert.deepEqual((await store.due('issue')).map(r => r.task.id), [repaired.task.id]);
});

test('migrated issue census and due reject miskeyed rows before binding/provider work', async () => {
  const storage = memoryStorage(), owner = migratedIssueIndexOwner(storage);
  const original = { ...row(1), sourceUpdatedAt: 1 }, wrong = migratedIssueKey('another-original');
  await storage.set(wrong, original); await owner.initialize();
  assert.deepEqual(await owner.due(MIGRATED_ISSUE_INDEX, 1000), {});
  const parked = (await storage.get(wrong))!.value as { disposition: string; _migratedIssueRecoveryCorruption: unknown };
  assert.equal(parked.disposition, 'needs_attention'); assert.deepEqual(parked._migratedIssueRecoveryCorruption, original);
  await owner.initialize(true);
  assert.deepEqual(await owner.due(MIGRATED_ISSUE_INDEX, 1000), {});
});

test('journal pending entries retain their actual source key and do not retire a different subject', async () => {
  const storage = memoryStorage(), journal = new SdkCommunityEventLog(storage);
  const subject = 'issue:owner/repo#1';
  await journal.append({ sourceEventId: 'original-route', subjectKey: subject, kind: 'case.routed',
    classification: 'state-changing', at: 1, payload: { ownerThreadId: 'home', catId: 'cat' } });
  const original = (await storage.get(SUBJECTS + hash(subject)))!.value;
  const wrong = SUBJECTS + hash('issue:owner/repo#2');
  await storage.compareAndSetIndexed!(wrong, null, original, { index: journalIndex('issue'), score: 0 });
  const due = await journal.pendingRoutes('issue', 1000);
  assert.equal(due.length, 1, 'a miskeyed subject cannot alias the correct pending obligation');
  assert.equal(due[0]!.subject, subject);
  const parked = (await storage.get(wrong))!.value as { disposition: string; _journalRecoveryCorruption: unknown };
  assert.equal(parked.disposition, 'needs_attention'); assert.deepEqual(parked._journalRecoveryCorruption, original);
  assert.deepEqual(await journal.listSubjects(), [subject], 'invalid directory history stays in diagnostics, not a fictitious subject');
  await assert.rejects(journal.read('issue:owner/repo#2'), /identity\/recovery mismatch/, 'an invalid subject is unknown, never a false empty history');
  const diagnosis = (await journal.recoveryDiagnostics()).entries.find(row => row.sourceKey === wrong)!;
  assert.equal(diagnosis.recovery.disposition, 'needs_attention');
  await journal.finishRoute(due[0]!.entry, false, 1000);
  await storage.rebuildIndex!(journalIndex('issue'));
  assert.deepEqual(await journal.pendingRoutes('issue', 1000), []);
});

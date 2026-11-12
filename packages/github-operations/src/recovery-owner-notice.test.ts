import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';
import { memoryStorage } from '../test/memory-storage.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { SdkCommunityCollectionStore } from './community-collection.js';
import { recoveryOwnerNotice, sendRecoveryOwnerNotice } from './recovery-owner-notice.js';
import { collectionKey, collectionIndex } from './community-collection-record.js';
import { migratedIssueKey, materializeMigratedIssue, type MigratedIssueRecord } from './migrated-issue-record.js';
import { MigratedIssueRuntime } from './migrated-issue-runtime.js';
import type { TaskItem } from './business/model/index.js';

test('status notification and archive response loss preserve the original exact intent across reroute/cancellation', async () => {
  let now = 1000, accepted = 0, loseMessage = true, loseArchive = true;
  const storage = memoryStorage(), journal = new SdkCommunityEventLog(storage);
  const route = { sourceEventId: 'original-route', subjectKey: 'issue:owner/repo#1', kind: 'case.routed' as const,
    classification: 'state-changing' as const, payload: { ownerThreadId: 'home', catId: 'old-cat' }, at: 1 };
  await journal.append(route);
  const store = new SdkCommunityCollectionStore(storage, () => now);
  await store.reconcileRoutes('issue');
  const task = (await store.getBySubject(route.subjectKey))!;
  for (let n = 0; n < 5; n++) { await store.finish((await store.read(task.id))!, 'failed'); now += 60_001; }
  const original = (await store.read(task.id))!;
  assert.ok(original.notice); assert.equal(original.recovery?.failures, 5);
  const receipts = new Set<string>();
  const context = { messaging: { send: async (thread: string, draft: { idempotencyKey: string; wake?: unknown }) => {
    assert.equal(thread, 'home'); assert.equal(draft.wake, undefined, 'a recovery notice cannot start another execution');
    if (!receipts.has(draft.idempotencyKey)) { receipts.add(draft.idempotencyKey); accepted++; }
    if (loseMessage) { loseMessage = false; throw new Error('accepted response lost'); }
    return { messageId: 'same-message', threadId: thread };
  } } } as unknown as FeatureContext;
  const send = sendRecoveryOwnerNotice(context);
  await store.deliverNotice(original, send);
  assert.equal((await store.read(task.id))?.notice?.state, 'pending');
  now += 60_001;
  await new SdkCommunityCollectionStore(storage, () => now).deliverNotice((await store.read(task.id))!, send);
  assert.equal((await store.read(task.id))?.notice?.state, 'delivered'); assert.equal(accepted, 1);
  const delivered = (await store.read(task.id))!;
  await journal.append({ ...route, sourceEventId: 'new-route', payload: { ownerThreadId: 'other-home', catId: 'new-cat' } });
  await store.reconcileRoutes('issue'); await store.delete(task.id);
  const cas = storage.compareAndSet;
  storage.compareAndSet = async (key, revision, value) => {
    const result = await cas(key, revision, value);
    if (loseArchive && key.startsWith('github.recovery-notice.archive.') && result.applied) {
      loseArchive = false; throw new Error('archive committed response lost');
    }
    return result;
  };
  await store.deliverNotice(delivered, send);
  assert.equal((await store.read(task.id))?.notice?.archiveAttempts, 1);
  now += 60_001;
  await store.deliverNotice((await store.read(task.id))!, send);
  const current = (await store.read(task.id))!;
  assert.equal(current.notice, undefined, 'archive retries compare exact logical identity, independent of retry timestamps');
  assert.equal(current.task.status, 'done'); assert.equal(current.task.ownerCatId, 'new-cat');
  assert.equal(current.recovery?.failures, 0, 'an old notice cannot charge or clear the new route');
  assert.equal(accepted, 1);
  const archived = Object.entries(await storage.list()).filter(([key]) => key.startsWith('github.recovery-notice.archive.'));
  assert.equal(archived.length, 1);
});

const legacyError = { name: 'Error', message: 'GitHub command failed', code: 1, stderr: 'Get "https://api.github.com/user": EOF' };

test('legacy hard faults already notified do not alert again solely because notice keys gained a revision', async () => {
  const storage = memoryStorage(), journal = new SdkCommunityEventLog(storage);
  await journal.append({ sourceEventId: 'legacy-hard-route', subjectKey: 'issue:owner/repo#1', kind: 'case.routed',
    classification: 'state-changing', payload: { ownerThreadId: 'home', catId: 'cat' }, at: 1 });
  const store = new SdkCommunityCollectionStore(storage); await store.reconcileRoutes('issue');
  const task = (await store.getBySubject('issue:owner/repo#1'))!, key = collectionKey(task.id), entry = (await storage.get(key))!;
  const row = entry.value as { recovery: { scope: string } };
  const oldKey = recoveryOwnerNotice('collection', row.recovery.scope, 'home', task.subjectKey!)!.key;
  await storage.compareAndSetIndexed!(key, entry.revision, { ...entry.value as object,
    recovery: { ...row.recovery, failures: 5, revision: 5, nextAt: 0, disposition: 'needs_attention',
      reasonCode: 'collection_observation_failed', lastNoticeKey: oldKey } }, { index: collectionIndex('issue'), score: null });
  await storage.delete!('community.collection.census.v2'); await new SdkCommunityCollectionStore(storage).initialize();
  assert.equal((await store.read(task.id))!.notice, undefined);
});

test('a cancelled legacy collection notice retains history without consuming the next fault alert', async () => {
  let now = 1000;
  const storage = memoryStorage(), journal = new SdkCommunityEventLog(storage);
  await journal.append({ sourceEventId: 'legacy-notice-route', subjectKey: 'issue:owner/repo#1', kind: 'case.routed',
    classification: 'state-changing', payload: { ownerThreadId: 'home', catId: 'cat' }, at: 1 });
  const before = new SdkCommunityCollectionStore(storage, () => now); await before.reconcileRoutes('issue');
  const task = (await before.getBySubject('issue:owner/repo#1'))!, row = (await before.read(task.id))!;
  const key = collectionKey(task.id), entry = (await storage.get(key))!;
  const notice = recoveryOwnerNotice('collection', row.recovery!.scope, 'home', task.subjectKey!)!;
  await storage.compareAndSetIndexed!(key, entry.revision, { ...entry.value as object, notice,
    recovery: { ...row.recovery!, revision: 5, failures: 5, disposition: 'needs_attention',
      reasonCode: 'collection_observation_failed', lastError: legacyError } }, { index: collectionIndex('issue'), score: null });
  await storage.delete!('community.collection.census.v2');
  await storage.set('community.collection.census.v1', { v: 1, status: 'ready', cursor: '0' });
  const store = new SdkCommunityCollectionStore(storage, () => now); await store.initialize();
  const sent: string[] = [], send = async (n: { key: string }) => { sent.push(n.key); return { messageId: 'actual-alert' }; };
  await store.deliverNotice((await store.read(task.id))!, send);
  await store.finish((await store.read(task.id))!, 'succeeded');
  for (let n = 0; n < 5; n++) { now += 60_001; await store.finish((await store.read(task.id))!, 'failed'); }
  const hard = (await store.read(task.id))!;
  assert.equal(hard.notice?.state, 'pending'); assert.notEqual(hard.notice?.key, notice.key);
  await store.deliverNotice(hard, send); await store.deliverNotice((await store.read(task.id))!, send);
  assert.equal(sent.length, 1); assert.equal((await store.read(task.id))!.notice, undefined);
  const archives = Object.entries(await storage.list()).filter(([k]) => k.startsWith('github.recovery-notice.archive.'));
  assert.equal(archives.length, 2, 'both the cancelled intent and actual delivery remain durable');
});

test('a cancelled legacy migrated notice cannot suppress or collide with its later hard-fault alert', async () => {
  let now = 1000, hardFailure = false;
  const storage = memoryStorage(), sent: string[] = [];
  const task: TaskItem = { id: 'legacy-notice-issue', kind: 'issue_tracking', subjectKey: 'issue:owner/repo#1', userId: 'owner',
    ownerCatId: 'cat', threadId: 'home', status: 'doing', title: 'Original', why: '', createdBy: 'cat', createdAt: 1, updatedAt: 1,
    automationState: { issue: { lastCommentCursor: 10, lastDeliveredCursor: 10, issueState: 'open' } } };
  const key = migratedIssueKey(task.id), row = materializeMigratedIssue({ schemaVersion: 1, task, sourceUpdatedAt: 1 }, key) as MigratedIssueRecord;
  const notice = recoveryOwnerNotice('migrated-issue', row.recovery!.scope, 'home', task.subjectKey!)!;
  await storage.compareAndSetIndexed!(key, null, { ...row, notice, recovery: { ...row.recovery!, revision: 5, failures: 5,
    disposition: 'needs_attention', reasonCode: 'migrated_issue_observation_failed', lastError: legacyError } },
    { index: 'github-migrated-issues', score: null });
  const context = { storage, config: { get: async () => undefined }, secrets: { get: async () => undefined },
    tasks: { get: async () => task }, log() {}, messaging: { send: async (_thread: string, draft: { idempotencyKey: string }) => {
      sent.push(draft.idempotencyKey); return { messageId: 'actual-alert', threadId: 'home' };
    } } } as unknown as FeatureContext;
  const runtime = new MigratedIssueRuntime(context, { read: async () => {
    if (hardFailure) throw new Error('HTTP 401: authentication required');
    return { state: 'open', commentsComplete: true, comments: [], reviews: [] };
  } }, () => 'self', () => now);
  try {
    await runtime.poll(); hardFailure = true;
    for (let n = 0; n < 5; n++) { now += 60_001; await runtime.poll(); }
    const hard = (await storage.get(key))!.value as MigratedIssueRecord;
    assert.equal(hard.notice?.state, 'pending'); assert.notEqual(hard.notice?.key, notice.key);
    await runtime.poll(); await runtime.poll();
    assert.equal(sent.length, 1); assert.equal(((await storage.get(key))!.value as MigratedIssueRecord).notice, undefined);
    assert.equal(Object.keys(await storage.list()).filter(k => k.startsWith('github.recovery-notice.archive.')).length, 2);
  } finally { await runtime.stop(); }
});

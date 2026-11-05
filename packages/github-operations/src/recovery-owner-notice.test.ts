import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';
import { memoryStorage } from '../test/memory-storage.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { SdkCommunityCollectionStore } from './community-collection.js';
import { sendRecoveryOwnerNotice } from './recovery-owner-notice.js';

test('status notification and archive response loss preserve the original exact intent across reroute/cancellation', async () => {
  let now = 1000, accepted = 0, loseMessage = true, loseArchive = true;
  const storage = memoryStorage(), journal = new SdkCommunityEventLog(storage);
  const route = { sourceEventId: 'original-route', subjectKey: 'issue:owner/repo#1', kind: 'case.routed' as const,
    classification: 'state-changing' as const, payload: { ownerThreadId: 'home', catId: 'old-cat' }, at: 1 };
  await journal.append(route);
  const store = new SdkCommunityCollectionStore(storage, () => now);
  await store.reconcileRoutes('issue');
  const task = (await store.getBySubject(route.subjectKey))!;
  for (let n = 0; n < 5; n++) { await store.finish((await store.read(task.id))!, true); now += 60_001; }
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

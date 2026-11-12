import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureContext } from '@clowder-ai/plugin-sdk';
import { memoryStorage } from '../test/memory-storage.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { JournalDirectory, JOURNAL_HEAD, SUBJECTS, journalIndex, eventKey } from './business/domains/community/journal-directory.js';
import { CommunityCollectionRuntime, SdkCommunityCollectionStore } from './community-collection.js';
import { collectionIndex } from './community-collection-record.js';
import { MigratedIssueRuntime } from './migrated-issue-runtime.js';
import { migratedIssueKey, MIGRATED_ISSUE_INDEX } from './migrated-issue-record.js';
import { GitHubRateLimitError } from './business/infrastructure/github/request-budget.js';
import type { CommunityEvent, TaskItem } from './business/model/index.js';

const route = (id: string, subject = 'issue:owner/repo#1', cat = 'cat'): CommunityEvent => ({
  sourceEventId: id, subjectKey: subject, kind: 'case.routed', classification: 'state-changing', at: 1,
  payload: { ownerThreadId: 'home', catId: cat, userId: 'owner' },
});
const snapshot = { state: 'open' as const, commentsComplete: true, comments: [], reviews: [] };

test('intermittent collection failures are reset only by successful collection, never by quota deferral', async t => {
  let now = 1000, failure: Error | undefined;
  const storage = memoryStorage(), store = new SdkCommunityCollectionStore(storage, () => now);
  await new SdkCommunityEventLog(storage).append(route('intermittent-route'));
  const runtime = new CommunityCollectionRuntime({ store, now: () => now, allowed: async () => true,
    provider: { read: async () => { if (failure) throw failure; return snapshot; } }, collect: async () => {}, observe: async () => {} });
  t.after(() => runtime.stop());
  for (let n = 0; n < 7; n++) {
    failure = new Error('temporary collection failure'); await assert.rejects(runtime.poll('issue')); now += 60_001;
    const task = (await store.getBySubject('issue:owner/repo#1'))!;
    failure = new GitHubRateLimitError(now + 60_000); await runtime.poll('issue'); now += 60_001;
    assert.equal((await store.read(task.id))!.recovery!.failures, 1, 'quota cannot erase unresolved failures');
    failure = undefined; await runtime.poll('issue'); now += 60_001;
    assert.equal((await store.read(task.id))!.recovery!.failures, 0);
  }
});

test('successful journal reconciliation clears its consecutive failure streak', async () => {
  const storage = memoryStorage(), journal = new SdkCommunityEventLog(storage);
  await journal.append(route('journal-streak'));
  let now = 1000;
  await journal.finishRoute((await journal.pendingRoutes('issue', now))[0]!.entry, true, now);
  now += 60_001;
  await journal.finishRoute((await journal.pendingRoutes('issue', now))[0]!.entry, false, now);
  const recovery = (await journal.recoveryDiagnostics()).entries[0]!.recovery;
  assert.equal('failures' in recovery && recovery.failures, 0);
  assert.equal('pending' in recovery && recovery.pending, false);
});

test('journal materialization converges when a concurrent owner has already assigned this stale event its subject position', async () => {
  const storage = memoryStorage(), event = route('concurrent-original');
  await storage.set(eventKey(event.sourceEventId), { sequence: 0, event });
  const original = (await storage.get(eventKey(event.sourceEventId)))!;
  await new JournalDirectory(storage).materialize(original);
  const canonical = await storage.list();
  await new JournalDirectory(storage).materialize(original);
  assert.deepEqual(await storage.list(), canonical, 'a stale selected version cannot create another logical event or sequence');
});

test('journal append/read and route recovery use direct original references after preparation; a late ack cannot clear a reroute', async () => {
  const storage = memoryStorage(), journal = new SdkCommunityEventLog(storage), store = new SdkCommunityCollectionStore(storage);
  await journal.append(route('route-one'));
  await store.initialize();
  storage.scan = async () => { throw new Error('periodic namespace scan forbidden'); };
  storage.list = async () => { throw new Error('periodic full list forbidden'); };
  const old = (await journal.pendingRoutes('issue', Date.now()))[0]!;
  assert.equal((await journal.append(route('route-two', undefined, 'new-cat'))).sequence, 1);
  await journal.finishRoute(old.entry, false, Date.now());
  assert.equal((await journal.pendingRoutes('issue', Date.now())).length, 1);
  await store.reconcileRoutes('issue');
  assert.equal((await store.getBySubject('issue:owner/repo#1'))?.ownerCatId, 'new-cat');
  assert.deepEqual((await journal.read('issue:owner/repo#1', 1)).map(event => event.sourceEventId), ['route-two']);
  assert.equal((await journal.append(route('route-two'))).appended, false);
  await storage.rebuildIndex!(journalIndex('issue'));
  assert.equal((await journal.pendingRoutes('issue', Date.now())).length, 0, 'acked historical routes do not revive');
});

test('an append-to-directory crash retains the original reservation until route debt is discoverable', async () => {
  const storage = memoryStorage(), indexed = storage.compareAndSetIndexed!;
  let crash = true;
  storage.compareAndSetIndexed = async (key, revision, value, projection) => {
    if (crash && key.startsWith(SUBJECTS)) { crash = false; throw new Error('directory write failed'); }
    return indexed(key, revision, value, projection);
  };
  await assert.rejects(new SdkCommunityEventLog(storage).append(route('original-route')), /directory write failed/);
  assert.ok(await storage.get(eventKey('original-route')));
  assert.ok((await storage.get(JOURNAL_HEAD))?.value);
  const recovered = new SdkCommunityCollectionStore(storage);
  await recovered.reconcileRoutes('issue');
  assert.equal((await recovered.getBySubject('issue:owner/repo#1'))?.ownerCatId, 'cat');
  assert.deepEqual((await new SdkCommunityEventLog(storage).read('issue:owner/repo#1')).map(e => e.sourceEventId), ['original-route']);
});

test('collection genuine failures spend five durable attempts and leave healthy work alive; quota deferral spends none', async t => {
  let now = 1000;
  const storage = memoryStorage(), journal = new SdkCommunityEventLog(storage), store = new SdkCommunityCollectionStore(storage, () => now);
  for (const id of [1, 2]) await journal.append(route(`route-${id}`, `issue:owner/repo#${id}`));
  let brokenReads = 0, healthyReads = 0, notices = 0;
  const runtime = new CommunityCollectionRuntime({ store, now: () => now, allowed: async () => true,
    notify: async () => { notices++; return { messageId: 'same-status-notice' }; },
    provider: { read: async target => {
      if (target.number === 1) { brokenReads++; throw new Error('real observation failure'); }
      healthyReads++; return snapshot;
    } }, collect: async () => {}, observe: async () => {} });
  t.after(() => runtime.stop());
  for (let n = 0; n < 10; n++) { await runtime.poll('issue').catch(() => {}); now += 60_001; }
  assert.equal(brokenReads, 5); assert.equal(healthyReads, 10);
  assert.equal(notices, 1);
  const broken = await store.getBySubject('issue:owner/repo#1');
  assert.equal((await store.read(broken!.id))?.recovery?.failures, 5);
  assert.equal(broken?.status, 'doing', 'automatic queue exit cannot fabricate business completion');
  await store.initialize(true);
  assert.equal((await store.due('issue')).some(row => row.task.id === broken!.id), false);
  const quotaStorage = memoryStorage(), quotaStore = new SdkCommunityCollectionStore(quotaStorage, () => now);
  await new SdkCommunityEventLog(quotaStorage).append(route('quota-route'));
  const quota = new CommunityCollectionRuntime({ store: quotaStore, now: () => now, allowed: async () => true,
    provider: { read: async () => { throw new GitHubRateLimitError(now + 90_000); } }, collect: async () => {}, observe: async () => {} });
  t.after(() => quota.stop()); await quota.poll('issue');
  const task = await quotaStore.getBySubject('issue:owner/repo#1');
  assert.equal((await quotaStore.read(task!.id))?.recovery?.failures, 0);
  assert.equal((await quotaStore.read(task!.id))?.recovery?.nextAt, now + 90_000);
  await quotaStorage.rebuildIndex!(collectionIndex('issue'));
  assert.deepEqual(await quotaStore.due('issue'), []);
});

test('migrated issue outbox reuses its original key after message acceptance and lost ack without provider replay', async () => {
  const storage = memoryStorage(); let now = 1000, reads = 0, deliveries = 0, failAck = true;
  const task: TaskItem = { id: 'original-issue', kind: 'issue_tracking', subjectKey: 'issue:owner/repo#1', userId: 'owner',
    threadId: 'home', ownerCatId: 'cat', status: 'doing', title: 'Original issue', why: '', createdBy: 'cat',
    createdAt: 1, updatedAt: 1, automationState: { issue: { lastCommentCursor: 10, lastDeliveredCursor: 10, issueState: 'open' } } };
  const key = migratedIssueKey(task.id), accepted = new Set<string>();
  await storage.set(key, { schemaVersion: 1, task, sourceUpdatedAt: 1 });
  const indexed = storage.compareAndSetIndexed!;
  storage.compareAndSetIndexed = async (name, revision, value, projection) => {
    const old = await storage.get(name);
    if (name === key && failAck && (old?.value as { outbox?: unknown })?.outbox && !(value as { outbox?: unknown }).outbox) {
      failAck = false; throw new Error('ack disk unavailable');
    }
    return indexed(name, revision, value, projection);
  };
  const context = { storage, config: { get: async () => undefined }, tasks: { get: async () => task }, log: () => {},
    messaging: { send: async (_thread: string, draft: { idempotencyKey: string }) => {
      if (!accepted.has(draft.idempotencyKey)) { accepted.add(draft.idempotencyKey); deliveries++; }
      return { messageId: 'same-original-receipt', threadId: 'home' };
    } } } as unknown as FeatureContext;
  const provider = { read: async () => { reads++; return { ...snapshot,
    comments: [{ id: 11, author: 'contributor', body: 'new comment', commentType: 'conversation' as const }] }; } };
  const first = new MigratedIssueRuntime(context, provider, () => 'self', () => now);
  await first.poll(); await first.stop();
  assert.equal((await storage.get(key))?.value && deliveries, 1);
  const pending = (await storage.get(key))!.value as { outbox: { key: string }; recovery: { failures: number } };
  assert.ok(pending.outbox.key); assert.equal(pending.recovery.failures, 1);
  now += 60_001;
  const cold = new MigratedIssueRuntime(context, provider, () => 'self', () => now);
  await cold.poll(); await cold.stop();
  const after = (await storage.get(key))!.value as { task: TaskItem; outbox?: unknown; sourceUpdatedAt: number; recovery: { failures: number } };
  assert.equal(after.outbox, undefined); assert.equal(deliveries, 1); assert.equal(reads, 1);
  assert.equal(after.task.id, task.id); assert.equal(after.task.automationState?.issue?.lastDeliveredCursor, 11);
  assert.equal(after.sourceUpdatedAt, 1); assert.equal(after.recovery.failures, 0);
  await storage.rebuildIndex!(MIGRATED_ISSUE_INDEX);
  assert.equal(accepted.size, 1);
});

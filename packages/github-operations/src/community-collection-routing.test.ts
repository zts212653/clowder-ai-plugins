import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryStorage } from '../test/memory-storage.js';
import { createCommunityHttpRouter } from './community-http-router.js';
import { CommunityCollectionRuntime, SdkCommunityCollectionStore } from './community-collection.js';
import { CommunityProjectionOperations } from './business/domains/community/community-projector.js';
import { SdkCommunityWorkflowIssueStore } from './business/domains/community/CommunityWorkflowStores.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { registerRoutingTracking } from './business/domains/community/community-auto-tracking.js';

async function fixture() {
  const storage = memoryStorage(), issues = new SdkCommunityWorkflowIssueStore(storage);
  const issue = (await issues.create({ repo: 'org/repo', issueNumber: 1, issueType: 'bug', title: 'Route recovery' }))!;
  const router = await createCommunityHttpRouter({ storage, projectionOperations: new CommunityProjectionOperations(),
    threads: { get: async id => ({ id, title: 'Thread', deepLinkUrl: '/threads/'+id, createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [] }), ensureByKey: async () => { throw new Error('unexpected creation'); } },
    issues: { guardianCatalog: async () => { throw new Error('unused catalog'); } },
    drafts: { frustration: { getSource: async () => null, linkDraft: async () => { throw new Error('unused source'); } }, publisher: { create: async () => { throw new Error('unused publish'); }, find: async () => null }, config: { defaultRepo: 'org/repo', repoAllowlist: ['org/repo'] } },
  });
  const store = new SdkCommunityCollectionStore(storage), events = new SdkCommunityEventLog(storage);
  const route = async (catId: string) => {
    await issues.update(issue.id, { state: 'pending-decision' });
    return router.forwardOwner({ principal: { kind: 'owner', id: 'owner' }, method: 'POST', path: `github/community-issues/${issue.id}/resolve`, body: { decision: 'accepted', threadId: 'thread', catId } });
  };
  const collected: string[] = [];
  const runtime = () => new CommunityCollectionRuntime({ store: new SdkCommunityCollectionStore(storage), allowed: async () => true,
    provider: { read: async () => ({ state: 'open', commentsComplete: true, comments: [], reviews: [] }) },
    collect: async target => { collected.push(target.catId); }, observe: async () => {} });
  return { storage, store, events, router, route, runtime, collected };
}

for (const nextCat of ['old-cat', 'new-cat']) test(`real resolve cancel and same-thread reroute creates a new canonical collection generation (${nextCat})`, async t => {
  const f = await fixture(); t.after(() => f.router.stop());
  assert.equal((await f.route('old-cat')).status, 200);
  const old = (await f.events.read('issue:org/repo#1')).find(e => e.kind === 'case.routed')!;
  await f.store.delete((await f.store.getBySubject(old.subjectKey))!.id);
  assert.equal((await f.route(nextCat)).status, 200);
  assert.equal((await f.store.getBySubject(old.subjectKey))?.ownerCatId, nextCat);
  await registerRoutingTracking(old, f.store);
  assert.equal((await f.store.getBySubject(old.subjectKey))?.ownerCatId, nextCat, 'old event replay cannot overwrite latest owner');
  await f.store.delete((await f.store.getBySubject(old.subjectKey))!.id);
  const runtime = f.runtime(); t.after(() => runtime.stop()); await runtime.poll('issue');
  assert.equal(await f.store.getBySubject(old.subjectKey), null, 'same generation recovery must retain cancellation');
});

test('real router committed route survives collection CAS failure and a fresh runtime recovers it', async t => {
  const f = await fixture(); t.after(() => f.router.stop());
  const cas = f.storage.compareAndSet; let fail = true;
  f.storage.compareAndSet = async (key, revision, value) => {
    if (fail && key.startsWith('community.collection.v1.')) throw new Error('collection write unavailable');
    return cas(key, revision, value);
  };
  await f.route('new-cat');
  assert.equal((await f.events.read('issue:org/repo#1')).filter(e => e.kind === 'case.routed').length, 1);
  assert.equal(await f.store.getBySubject('issue:org/repo#1'), null);
  await f.router.stop(); fail = false;
  const runtime = f.runtime(); t.after(() => runtime.stop()); await runtime.poll('issue');
  assert.deepEqual(f.collected, ['new-cat']);
  assert.equal((await f.store.getBySubject('issue:org/repo#1'))?.ownerCatId, 'new-cat');
});

test('delayed old reconciliation loses CAS to the latest committed route and cannot roll its owner back', async t => {
  const f = await fixture(); t.after(() => f.router.stop());
  const cas = f.storage.compareAndSet; let fail = true;
  f.storage.compareAndSet = async (key, revision, value) => {
    if (fail && key.startsWith('community.collection.v1.')) throw new Error('initial collection unavailable');
    return cas(key, revision, value);
  };
  await f.route('old-cat'); fail = false;
  const old = (await f.events.read('issue:org/repo#1')).find(e => e.kind === 'case.routed')!;
  let entered!: () => void, release!: () => void, blocked = false;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.storage.compareAndSet = async (key, revision, value) => {
    if (!blocked && key.startsWith('community.collection.v1.')) { blocked = true; entered(); await gate; }
    return cas(key, revision, value);
  };
  const pending = registerRoutingTracking(old, f.store); await reached;
  try { assert.equal((await f.route('new-cat')).status, 200); }
  finally { release(); }
  await pending;
  assert.equal((await f.store.getBySubject(old.subjectKey))?.ownerCatId, 'new-cat');
});

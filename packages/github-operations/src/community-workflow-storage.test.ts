import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryStorage } from '../test/memory-storage.js';
import { SdkCommunityWorkflowIssueStore, SdkCommunityPrStore, SdkCommunityIssueDraftStore } from './business/domains/community/CommunityWorkflowStores.js';

test('issue workflow survives recreation and merges concurrent disjoint updates', async () => {
  const storage = memoryStorage();
  const a = new SdkCommunityWorkflowIssueStore(storage), b = new SdkCommunityWorkflowIssueStore(storage);
  const input = { repo: 'Org/Repo', issueNumber: 1, issueType: 'bug' as const, title: 'Bug' };
  const results = await Promise.all([a.create(input), b.create({ ...input, repo: 'org/repo' })]);
  assert.equal(results.filter(Boolean).length, 1);
  const issue = results.find(Boolean)!;
  const guardian = { guardianCatId: 'guardian', signoffTokenHash: 'hash', requestedAt: 1, requestedBy: 'owner', signedOff: false, checklist: [] };
  await Promise.all([
    a.update(issue.id, { state: 'accepted', assignedCatId: 'owner', assignedThreadId: 'thread', routeAcceptance: 'pending', routeSource: 'auto' }),
    b.update(issue.id, { guardianAssignment: guardian, directionCard: { entries: [{ catId: 'reviewer' }] }, ownerDecision: 'accepted' }),
  ]);
  const restored = await new SdkCommunityWorkflowIssueStore(storage).getByRepoAndNumber('ORG/REPO', 1);
  assert.equal(restored?.state, 'accepted');
  assert.equal(restored?.assignedThreadId, 'thread');
  assert.deepEqual(restored?.guardianAssignment, guardian);
  assert.equal(restored?.ownerDecision, 'accepted');
  assert.equal(restored?.routeAcceptance, 'pending');
  await assert.rejects(a.update(issue.id, { repo: 'other/repo' } as never));
  assert.equal((await a.listAll()).length, 1);
});

test('PR provider updates preserve review cursor and survive recreation', async () => {
  const storage = memoryStorage(); const a = new SdkCommunityPrStore(storage), b = new SdkCommunityPrStore(storage);
  const input = { repo: 'org/repo', prNumber: 2, title: 'PR', author: 'external', state: 'open' as const, replyState: 'unreplied' as const, headSha: 'a', draft: false };
  const results = await Promise.all([a.create(input), b.create(input)]);
  const pr = results.find(Boolean)!; assert.equal(results.filter(Boolean).length, 1);
  await Promise.all([a.update(pr.id, { lastReviewedSha: 'a' }), b.update(pr.id, { headSha: 'b', state: 'merged' })]);
  const restored = await new SdkCommunityPrStore(storage).get(pr.id);
  assert.equal(restored?.lastReviewedSha, 'a'); assert.equal(restored?.headSha, 'b'); assert.equal(restored?.state, 'merged');
});

const draftInput = { sourceType: 'cat_initiated' as const, sourceId: 'source-1', title: 'Draft', bodyMarkdown: 'body', targetRepo: 'org/repo', labels: ['bug'], threadId: 'thread', userId: 'owner' };
test('draft source reservation and record are atomic; cancelled history survives reuse', async () => {
  const storage = memoryStorage(); const a = new SdkCommunityIssueDraftStore(storage), b = new SdkCommunityIssueDraftStore(storage);
  const results = await Promise.allSettled([a.create(draftInput), b.create(draftInput)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const first = await a.getBySourceId('source-1'); assert.ok(first);
  await a.cancel(first.draftId);
  const second = await b.create(draftInput); assert.notEqual(second.draftId, first.draftId);
  const restored = new SdkCommunityIssueDraftStore(storage);
  assert.equal((await restored.getById(first.draftId))?.status, 'cancelled');
  assert.equal((await restored.getBySourceId('source-1'))?.draftId, second.draftId);
  const race = await Promise.allSettled([
    a.cancel(second.draftId),
    b.beginPublish(second.draftId, 'Draft', 'body'),
  ]);
  assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(restored.updateContent(second.draftId, 'changed', 'body'), /not draft/);
});

test('draft write acknowledged only after durable source aggregate; lost response does not create second active draft', async () => {
  const storage = memoryStorage(); const cas = storage.compareAndSet; let lost = true;
  const a = new SdkCommunityIssueDraftStore({ ...storage, async compareAndSet(key, expected, value) {
    const result = await cas(key, expected, value);
    if (result.applied && lost) { lost = false; throw new Error('response lost'); }
    return result;
  } });
  await assert.rejects(a.create(draftInput), /response lost/);
  const restored = new SdkCommunityIssueDraftStore(storage);
  const draft = await restored.getBySourceId('source-1'); assert.ok(draft);
  assert.equal((await restored.getById(draft.draftId))?.title, 'Draft');
  await assert.rejects(restored.create(draftInput), /active draft/);
});

test('delete loses to a concurrent workflow update without removing the newer record', async () => {
  const storage = memoryStorage(); const remove = storage.delete; let changed = false;
  const store = new SdkCommunityWorkflowIssueStore({ ...storage, async delete(key, revision) {
    if (!changed) {
      changed = true; const entry = await storage.get(key);
      await storage.set(key, { ...(entry!.value as object), state: 'accepted' });
    }
    return remove(key, revision);
  } });
  const issue = (await store.create({ repo: 'org/repo', issueNumber: 2, issueType: 'bug', title: 'race' }))!;
  assert.equal(await store.delete(issue.id), false);
  assert.equal((await store.get(issue.id))?.state, 'accepted');
});

test('incomplete published draft is rejected on reload', async () => {
  const storage = memoryStorage(); const store = new SdkCommunityIssueDraftStore(storage);
  const draft = await store.create(draftInput);
  const entries = Object.entries(await storage.list());
  const [key, entry] = entries[0]!;
  const state = entry.value as { drafts: Record<string, { status: string }> };
  state.drafts[draft.draftId]!.status = 'published';
  await storage.set(key, state);
  await assert.rejects(new SdkCommunityIssueDraftStore(storage).getById(draft.draftId), /published/i);
});

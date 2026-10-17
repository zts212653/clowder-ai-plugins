import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryStorage } from '../test/memory-storage.js';
import { createCommunityHttpRouter, type CommunityHttpRouterOptions } from './community-http-router.js';
import { CommunityProjector, CommunityProjectionOperations } from './business/domains/community/community-projector.js';
import { createCatId } from './business/model/index.js';
import { SdkCommunityWorkflowIssueStore, SdkCommunityIssueDraftStore, SdkCommunityPrStore } from './business/domains/community/CommunityWorkflowStores.js';
import { SdkCommunityRepoConfigStore } from './business/domains/community/CommunityRepoConfigStore.js';
import { NativeIssueDraftRuntime } from './native-issue-drafts.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { SdkCommunityObjectStore } from './business/domains/community/CommunityObjectStore.js';
import { CommunityReconciliationFindingStore } from './business/domains/community/reconciliation/CommunityReconciliationFindingStore.js';

function options(): CommunityHttpRouterOptions {
  return {
    storage: memoryStorage(),
    threads: { get: async () => null, ensureByKey: async () => { throw new Error('unexpected thread creation'); } },
    projectionOperations: new CommunityProjectionOperations(),
    issues: {
      guardianCatalog: async () => ({ roster: {}, defaultCatId: createCatId('guardian'), policy: { requireDifferentFamily: true, preferActiveInThread: true, preferLead: true, excludeUnavailable: true } }),
      taskStore: { listByKind: async () => [], getBySubject: async () => null, upsertBySubject: async () => { throw new Error('unexpected tracking'); }, delete: async () => false },
    },
    drafts: {
      frustration: { getSource: async () => null, linkDraft: async () => { throw new Error('unexpected source update'); } },
      publisher: { create: async () => { throw new Error('unexpected GitHub publish'); }, find: async () => null },
      config: { defaultRepo: 'org/repo', repoAllowlist: ['org/repo'] },
    },
  };
}
const principal = { kind: 'owner', id: 'owner' } as const;

test('real PR sync refuses failed review read without overwriting the existing workflow', async t => {
  const deps = options(), store = new SdkCommunityPrStore(deps.storage), head = 'a'.repeat(40);
  const before = (await store.create({ repo: 'org/repo', prNumber: 1, title: 'Existing', author: 'author', state: 'open', replyState: 'replied', headSha: head, draft: false }))!;
  deps.issues.fetchPrs = async () => [{ number: 1, title: 'Changed', state: 'open', merged_at: null, user: 'author', head_sha: head, draft: false, labels: [], updated_at: '2026-10-01T00:00:00Z' }];
  deps.issues.fetchPrReviews = async () => { throw new Error('provider review unavailable'); };
  const router = await createCommunityHttpRouter(deps); t.after(() => router.stop());
  const result = await router.forwardOwner({ principal, method: 'POST', path: 'github/community-issues/sync-prs', query: { repo: 'org/repo' } });
  assert.equal(result.status, 500); assert.deepEqual(await store.get(before.id), before);
});

test('embedded HTTP sync uses configured production reader and the private repository policy', async t => {
  const deps = options(); let reads = 0;
  const router = await createCommunityHttpRouter({ ...deps, provider: {
    token: async () => 'isolated-router-sync', execFileAsync: async () => { reads++; return { stdout: JSON.stringify({ number: 2, title: 'Fetched issue', state: 'open', labels: ['bug'], comments: 0, user: 'author', html_url: 'https://github.com/org/repo/issues/2', isPullRequest: false }) }; },
  } });
  t.after(() => router.stop());
  const request = { principal, method: 'POST', path: 'github/community-issues/sync', query: { repo: 'org/repo' } };
  assert.notEqual((await router.forwardOwner(request)).status, 200); assert.equal(reads, 0);
  await new SdkCommunityRepoConfigStore(deps.storage).upsert({ repo: 'org/repo', guardThreadId: 'thread', guardCatId: 'cat' });
  const result = await router.forwardOwner(request); assert.equal(result.status, 200); assert.equal(result.body.created, 1);
  assert.equal((await new SdkCommunityWorkflowIssueStore(deps.storage).getByRepoAndNumber('org/repo', 2))?.title, 'Fetched issue');
  assert.equal(reads, 1);
});

test('returned decision endpoint can be forwarded unchanged to its real package handler', async t => {
  const deps = options();
  const findings = new CommunityReconciliationFindingStore(deps.storage);
  const findingId = 'reconcile:issue:org/repo#1:changed%?';
  await findings.upsert({ findingId, subjectKey: 'issue:org/repo#1', findingKind: 'github-reopened-case-closed',
    severity: 'warning', message: 'Reopened' });
  const router = await createCommunityHttpRouter(deps); t.after(() => router.stop());
  const queue = await router.forwardOwner({ principal, method: 'GET', path: 'github/community-decision-queue', query: { repo: 'org/repo' } });
  assert.equal(queue.status, 200);
  const action = queue.body.items[0].recommendedActions.find((value: {kind: string}) => value.kind === 'acknowledge-finding');
  const prefix = '/api/plugins/official.github-operations/';
  assert.equal(action.endpoint, `${prefix}github/community-findings/${encodeURIComponent(findingId)}/acknowledge`);
  const response = await router.forwardOwner({ principal, method: action.method, path: action.endpoint.slice(prefix.length) });
  assert.equal(response.status, 200);
  assert.equal(response.body.finding.findingId, findingId);
  assert.equal((await findings.get(findingId))?.status, 'acknowledged');
});

for (const journal of [false, true]) test(`publication recovers after ${journal ? 'journal' : 'workflow'} result write loss`, async t => {
  const deps = options(); let creates = 0, finds = 0;
  const issue = { number: 7, url: 'https://github.com/org/repo/issues/7' };
  deps.drafts.publisher = { create: async draft => { creates++; assert.deepEqual(draft.labels, ['bug']); return issue; }, find: async () => { finds++; return issue; } };
  const store = new SdkCommunityIssueDraftStore(deps.storage);
  const draft = await store.create({ sourceType: 'cat_initiated', sourceId: 'source', title: 'I'.repeat(500), bodyMarkdown: 'Public body', targetRepo: 'org/repo', labels: ['bug'], threadId: 'thread', userId: 'owner' });
  const cas = deps.storage.compareAndSet; let fail = true;
  deps.storage.compareAndSet = async (key, rev, value) => {
    if (fail && key.startsWith(journal ? 'community.workflow.publication.' : 'community.workflow.draft-source.') && JSON.stringify(value).includes('"status":"published"')) throw new Error('local write lost');
    return cas(key, rev, value);
  };
  let router = await createCommunityHttpRouter(deps); t.after(() => router.stop());
  const read = await router.forwardOwner({ principal, method: 'GET', path: `github/community-issue-drafts/by-id/${draft.draftId}` });
  assert.equal(read.status, 200);
  assert.equal(read.body.draft.draftId, draft.draftId);
  assert.equal((await router.forwardOwner({ principal, method: 'GET', path: 'github/community-issue-drafts/config' })).status, 200);
  const request = { principal, method: 'POST', path: `github/community-issue-drafts/by-id/${draft.draftId}/publish`, body: {} };
  const first = await router.forwardOwner(request);
  assert.equal(first.status, 502); assert.equal(creates, 1);
  assert.equal((await store.getById(draft.draftId))?.status, 'publishing');
  const native = new NativeIssueDraftRuntime({ storage: deps.storage, config: { get: async () => 'org/repo' } }, deps.drafts.publisher);
  assert.deepEqual((await native.list()).data.rows, [], 'Community publication is not a separately cancellable native UI draft');
  await native.stop();
  assert.equal((await router.forwardOwner({ ...request, path: `github/community-issue-drafts/by-id/${draft.draftId}/cancel` })).status, 409);
  assert.equal((await router.forwardOwner({ ...request, body: { title: 'Changed' } })).status, 502);
  assert.equal(creates, 1);
  await router.stop(); fail = false;
  router = await createCommunityHttpRouter(deps);
  const retried = await router.forwardOwner(request);
  assert.equal(creates, 1, 'retry must reconcile durable publishing receipt instead of POST again');
  assert.equal(finds, journal ? 1 : 0);
  assert.equal(retried.body.draft.status, 'published');
  assert.equal((await new SdkCommunityIssueDraftStore(deps.storage).getById(draft.draftId))?.githubIssueNumber, 7);
});

test('concurrent routers freeze one publication and reconcile uncertain results without another POST', async t => {
  const deps = options(); let creates = 0; let found = false;
  let entered!: () => void, release!: () => void;
  const creating = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  deps.drafts.publisher = { create: async () => { creates++; entered(); await blocked; throw new Error('response unknown'); }, find: async () => found ? { number: 7, url: 'https://github.com/org/repo/issues/7' } : null };
  const store = new SdkCommunityIssueDraftStore(deps.storage);
  const draft = await store.create({ sourceType: 'cat_initiated', sourceId: 'source', title: 'Issue', bodyMarkdown: 'Public', targetRepo: 'org/repo', labels: [], threadId: 'thread', userId: 'owner' });
  const a = await createCommunityHttpRouter(deps), b = await createCommunityHttpRouter(deps);
  t.after(async () => { release(); await a.stop(); await b.stop(); });
  const request = { principal, method: 'POST', path: `github/community-issue-drafts/by-id/${draft.draftId}/publish`, body: {} };
  const pending = a.forwardOwner(request); await creating;
  assert.equal((await b.forwardOwner(request)).status, 202);
  await assert.rejects(store.cancel(draft.draftId), /not draft/);
  await assert.rejects(store.updateContent(draft.draftId, 'other', 'other'), /not draft/);
  release(); assert.equal((await pending).status, 202);
  found = true;
  assert.equal((await b.forwardOwner(request)).body.draft.status, 'published');
  assert.equal(creates, 1);
});

test('stop during a successful external POST leaves recoverable publishing state', async t => {
  const deps = options(); let creates = 0, finds = 0;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const issue = { number: 7, url: 'https://github.com/org/repo/issues/7' };
  deps.drafts.publisher = { create: async () => { creates++; entered(); await blocked; return issue; }, find: async () => { finds++; return issue; } };
  const store = new SdkCommunityIssueDraftStore(deps.storage);
  const draft = await store.create({ sourceType: 'cat_initiated', sourceId: 'source', title: 'Issue', bodyMarkdown: 'Public', targetRepo: 'org/repo', labels: [], threadId: 'thread', userId: 'owner' });
  let router = await createCommunityHttpRouter(deps); t.after(() => router.stop());
  const request = { principal, method: 'POST', path: `github/community-issue-drafts/by-id/${draft.draftId}/publish`, body: {} };
  const pending = router.forwardOwner(request); await started;
  const stopping = router.stop(); release();
  assert.equal((await pending).status, 502); await stopping;
  assert.equal((await store.getById(draft.draftId))?.status, 'publishing');
  router = await createCommunityHttpRouter(deps);
  assert.equal((await router.forwardOwner(request)).body.draft.status, 'published');
  assert.equal(creates, 1); assert.equal(finds, 1);
});

test('native report rejects other case owners, other threads and forged actors', async t => {
  const deps = options();
  let verified = false; let invalidate: (() => Promise<void>) | undefined;
  deps.issues.verifyPublicIssueComment = async () => { await invalidate?.(); return verified; };
  const issues = new SdkCommunityWorkflowIssueStore(deps.storage);
  const issue = (await issues.create({ repo: 'org/repo', issueNumber: 1, issueType: 'bug', title: 'Bug' }))!;
  await issues.update(issue.id, { assignedCatId: 'assigned', assignedThreadId: 'assigned-thread', state: 'accepted' });
  await new SdkCommunityObjectStore(deps.storage).save({ repo: 'org/repo', type: 'issue', number: 1, subjectKey: 'issue:org/repo#1', state: 'fixed', ownerThreadId: 'assigned-thread', ownerRole: 'assigned', nextOwner: 'role', lastExternalActivityAt: null, lastPublicCommentAt: null, linkedIssues: [], linkedPrs: [], closureWaiver: null, issueFixEvidence: null, externalReview: null, appliedEventCount: 0, lastRejectedEvent: null, deliveryCursor: null, createdAt: 1, updatedAt: 1 });
  const router = await createCommunityHttpRouter(deps); t.after(() => router.stop());
  const caller = { catId: 'intruder', threadId: 'assigned-thread', userId: 'owner', invocationId: 'inv', assertCurrent: async () => {} };
  const payload = { actor: 'assigned', publicCommentUrl: 'https://github.com/org/repo/issues/1#issuecomment-123' };
  assert.equal((await router.invokeNative('github.community.report', { id: issue.id, payload }, caller)).status, 403);
  assert.equal((await router.invokeNative('github.community.report', { id: issue.id, payload }, { ...caller, catId: 'assigned', threadId: 'other' })).status, 403);
  assert.equal((await router.invokeNative('github.community.report', { id: issue.id, payload: { ...payload, actor: 'fake' } }, { ...caller, catId: 'assigned' })).status, 403);
  assert.equal((await router.invokeNative('github.community.report', { id: issue.id, payload: { ...payload, publicCommentUrl: 'not-a-url' } }, { ...caller, catId: 'assigned' })).status, 400);
  assert.equal((await new SdkCommunityObjectStore(deps.storage).get('issue:org/repo#1'))?.lastPublicCommentAt, null);
  const assigned = { ...caller, catId: 'assigned' };
  assert.equal((await router.invokeNative('github.community.report', { id: issue.id, payload }, assigned)).status, 422);
  verified = true;
  invalidate = async () => { await issues.update(issue.id, { assignedCatId: 'new-owner' }); };
  assert.equal((await router.invokeNative('github.community.report', { id: issue.id, payload }, assigned)).status, 403);
  invalidate = undefined;
  await issues.update(issue.id, { assignedCatId: 'assigned' });
  const good = await router.invokeNative('github.community.report', { id: issue.id, payload: { publicCommentUrl: payload.publicCommentUrl } }, assigned);
  assert.equal(good.status, 200, JSON.stringify(good));
  const events = await new SdkCommunityEventLog(deps.storage).read('issue:org/repo#1');
  assert.equal(events.filter(event => event.kind === 'case.reported').length, 1);
  assert.equal(events.at(-1)?.payload.actor, 'assigned');
  assert.equal((await router.forwardOwner({ principal, method: 'POST', path: `github/community-issues/${issue.id}/waive-closure`, body: { reason: 'reason', actor: 'fake', evidence: 'evidence' } })).status, 403);

});

for (const terminal of ['closed', 'declined'] as const) test(`report cannot reopen ${terminal} while provider verification is pending`, async t => {
  const deps = options();
  let entered!: () => void, release!: () => void;
  const verifying = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  deps.issues.verifyPublicIssueComment = async () => { entered(); await blocked; return true; };
  const issues = new SdkCommunityWorkflowIssueStore(deps.storage);
  const issue = (await issues.create({ repo: 'org/repo', issueNumber: 1, issueType: 'bug', title: 'Bug' }))!;
  await issues.update(issue.id, { assignedCatId: 'assigned', assignedThreadId: 'thread' });
  const objects = new SdkCommunityObjectStore(deps.storage);
  const projection = { repo: 'org/repo', type: 'issue' as const, number: 1, subjectKey: 'issue:org/repo#1', state: 'fixed' as const, ownerThreadId: 'thread', ownerRole: 'assigned', nextOwner: 'role' as const, lastExternalActivityAt: null, lastPublicCommentAt: null, linkedIssues: [], linkedPrs: [], closureWaiver: null, issueFixEvidence: null, externalReview: null, appliedEventCount: 0, lastRejectedEvent: null, deliveryCursor: null, createdAt: 1, updatedAt: 1 };
  await objects.save(projection);
  const router = await createCommunityHttpRouter(deps);
  t.after(async () => { release(); await router.stop(); });
  const pending = router.invokeNative('github.community.report', { id: issue.id, payload: { publicCommentUrl: 'https://github.com/org/repo/issues/1#issuecomment-123' } }, { catId: 'assigned', threadId: 'thread', userId: 'owner', invocationId: 'inv', assertCurrent: async () => {} });
  await verifying;
  await objects.save({ ...projection, state: terminal });
  release();
  const response = await pending;
  const final = await objects.get(projection.subjectKey);
  assert.equal(final?.state, terminal, 'late report must not reopen the terminal projection');
  assert.equal(final?.lastPublicCommentAt, null, 'rejected report must not install closure evidence');
  assert.equal(response.status, 409);
});

test('embedded whole Community routes persist owner changes and accept separately authenticated native triage', async t => {
  const deps = options(); let router = await createCommunityHttpRouter(deps);
  t.after(() => router.stop());
  const created = await router.forwardOwner({ principal, method: 'POST', path: 'github/community-issues', body: { repo: 'org/repo', issueNumber: 1, title: 'Proposal', issueType: 'feature' } });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const path = `github/community-issues/${id}`;
  assert.equal((await router.forwardOwner({ principal, method: 'PATCH', path, body: { state: 'discussing' } })).status, 200);
  const payload = { catId: 'reviewer', verdict: 'WELCOME', questions: ['Q1','Q2','Q3','Q4','Q5'].map(id => ({ id, result: 'PASS' })) };
  assert.equal((await router.forwardOwner({ principal, method: 'POST', path: path + '/triage-complete', body: payload })).status, 401);
  const caller = { catId: 'reviewer', userId: 'owner', threadId: 'thread', invocationId: 'inv', assertCurrent: async () => {} };
  const result = await router.invokeNative('github.community.triage-complete', { id, payload }, caller);
  assert.equal(result.status, 200);
  assert.equal(result.body.action, 'await-second-cat');
  await assert.rejects(router.invokeNative('github.community.resolve' as never, { id, payload: { decision: 'accepted' } }, caller), /Undeclared/);
  await assert.rejects(router.invokeNative('github.community.triage-complete', { id, payload, principal }, caller), /Unrecognized/);
  await router.stop();
  router = await createCommunityHttpRouter(deps);
  const restored = await router.forwardOwner({ principal, method: 'GET', path });
  assert.equal(restored.body.directionCard.entries[0].catId, 'reviewer');
  const queue = await router.forwardOwner({ principal, method: 'GET', path: 'github/community-decision-queue', query: { repo: 'org/repo' } });
  assert.equal(queue.status, 200);
});

test('owner forwarding requires Host wrapper identity and preserves encoded repository segments', async t => {
  const router = await createCommunityHttpRouter(options()); t.after(() => router.stop());
  await assert.rejects(router.forwardOwner({ method: 'GET', path: 'github/community-issues', headers: { 'x-cat-cafe-user': 'owner' } }), /principal/);
  await assert.rejects(router.forwardOwner({ principal, method: 'GET', path: 'github/community-issues/../secrets' }), /Invalid/);
  assert.equal((await router.forwardOwner({ principal, method: 'POST', path: 'github/community-repo-configs', body: { repo: 'org/repo', guardCatId: 'guardian', guardThreadId: 'thread' } })).status, 200);
  assert.equal((await router.forwardOwner({ principal, method: 'DELETE', path: 'github/community-repo-configs/org%2Frepo' })).status, 200);
  const configs = await router.forwardOwner({ principal, method: 'GET', path: 'github/community-repo-configs' });
  assert.deepEqual(configs.body, []);
});

test('shared collector queue preserves request authority when a native report expires while queued', async t => {
  const deps = options();
  const events = new SdkCommunityEventLog(deps.storage), objects = new SdkCommunityObjectStore(deps.storage);
  const background = new CommunityProjector(events, objects, deps.projectionOperations);
  await background.apply({ sourceEventId: 'seed', subjectKey: 'issue:org/repo#1', kind: 'case.bootstrap', classification: 'state-changing', at: 1, payload: { mappedState: 'fixed' } });
  const issues = new SdkCommunityWorkflowIssueStore(deps.storage);
  const issue = (await issues.create({ repo: 'org/repo', issueNumber: 1, issueType: 'bug', title: 'Bug' }))!;
  await issues.update(issue.id, { assignedCatId: 'assigned', assignedThreadId: 'thread', state: 'accepted' });
  let verified!: () => void, release!: () => void;
  const verifying = new Promise<void>(resolve => { verified = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const holding = deps.projectionOperations.run('issue:ORG/REPO#1', () => blocked);
  deps.issues.verifyPublicIssueComment = async () => { verified(); return true; };
  const router = await createCommunityHttpRouter(deps); t.after(async () => { release(); await router.stop(); });
  let current = true;
  const request = router.invokeNative('github.community.report', { id: issue.id, payload: { publicCommentUrl: 'https://github.com/org/repo/issues/1#issuecomment-42' } }, {
    catId: 'assigned', threadId: 'thread', userId: 'owner', invocationId: 'inv', assertCurrent: async () => { if (!current) throw new Error('expired invocation'); },
  });
  await verifying;
  await new Promise(resolve => setImmediate(resolve));
  current = false; release(); await holding;
  assert.equal((await request).status, 500);
  assert.equal((await objects.get('issue:org/repo#1'))?.lastPublicCommentAt, null);
  // Failed request neither poisons the shared queue nor lends its identity to the collector.
  await background.apply({ sourceEventId: 'declined', subjectKey: 'issue:org/repo#1', kind: 'case.declined', classification: 'state-changing', at: 3, payload: {} });
  assert.equal((await objects.get('issue:org/repo#1'))?.state, 'declined');
});

for (const explicitNewThread of [false, true]) test(`real resolve route retries the same SDK thread binding after lost reply (explicit=${explicitNewThread})`, async t => {
  let creates = 0, lost = true;
  const bindings = new Map<string, string>();
  const deps: CommunityHttpRouterOptions = { ...options(), threads: {
    get: async () => null,
    ensureByKey: async (key, { title }) => {
      if (!bindings.has(key)) bindings.set(key, `thread-${++creates}`);
      if (lost) { lost = false; throw new Error('Host response lost'); }
      const id = bindings.get(key)!;
      return { id, title, deepLinkUrl: '/threads/'+id, createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [] };
    },
  } };
  const store = new SdkCommunityWorkflowIssueStore(deps.storage);
  const issue = (await store.create({ repo: 'org/repo', issueNumber: 23, issueType: 'bug', title: 'Retry routing' }))!;
  await store.update(issue.id, { state: 'pending-decision' });
  let router = await createCommunityHttpRouter(deps); t.after(() => router.stop());
  const request = { principal, method: 'POST', path: `github/community-issues/${issue.id}/resolve`, body: {
    decision: 'accepted', ...(explicitNewThread ? { routeRecommendation: { kind: 'new-thread' } } : {}),
  } };
  assert.equal((await router.forwardOwner(request)).status, 500);
  assert.equal((await store.get(issue.id))?.state, 'pending-decision');
  await router.stop(); router = await createCommunityHttpRouter(deps);
  assert.equal((await router.forwardOwner(request)).status, 200);
  assert.equal(creates, 1);
  assert.equal((await store.get(issue.id))?.assignedThreadId, 'thread-1');
});

function sourceFixture() {
  const source = { issueId: 'fi_source', userId: 'owner', threadId: 'thread', status: 'confirmed' as const,
    signalType: 'user_report' as const, signalDetail: {}, userDescription: 'Public report', recentMessageCount: 3,
    communityIssueDraftId: null as string | null, sourceRevision: 'source-r1' };
  let fail = false, lost = false, writes = 0;
  const port = {
    getSource: async () => structuredClone(source),
    linkDraft: async (input: import('@clowder-ai/plugin-contract').FrustrationLinkDraftInput): Promise<import('@clowder-ai/plugin-contract').FrustrationLinkDraftResult> => {
      writes++;
      if (fail) throw new Error('source unavailable');
      if (input.sourceRevision !== source.sourceRevision) return { outcome: 'stale_source' };
      if (source.communityIssueDraftId === input.draftId) return { outcome: 'already_linked', draftId: input.draftId, sourceRevision: source.sourceRevision };
      if (input.expectedDraftId !== source.communityIssueDraftId) return { outcome: 'conflict' };
      source.communityIssueDraftId = input.draftId;
      if (lost) { lost = false; throw new Error('link response lost'); }
      return { outcome: 'linked', draftId: input.draftId, sourceRevision: source.sourceRevision };
    },
  };
  const deps = options();
  Object.assign(deps.drafts, { frustration: port });
  const request = { principal, method: 'POST', path: 'github/community-issue-drafts/from-frustration-issue/fi_source' };
  return { deps, port, source, request, fail: (value: boolean) => { fail = value; }, loseReply: () => { lost = true; }, writes: () => writes };
}
for (const lostReply of [false, true]) test(`source link ${lostReply ? 'lost reply' : 'failure'} recovers the same persisted draft after restart`, async t => {
  const f = sourceFixture(); if (lostReply) f.loseReply(); else f.fail(true);
  let router = await createCommunityHttpRouter(f.deps); t.after(() => router.stop());
  assert.equal((await router.forwardOwner(f.request)).status, 502);
  const store = new SdkCommunityIssueDraftStore(f.deps.storage), saved = await store.getBySourceId(f.source.issueId); assert.ok(saved);
  assert.match(saved.bodyMarkdown, /3 conversation messages/);
  await router.stop(); f.fail(false); router = await createCommunityHttpRouter(f.deps);
  const retry = await router.forwardOwner(f.request); assert.equal(retry.status, 200); assert.equal(retry.body.draft.draftId, saved.draftId);
  assert.equal(f.source.communityIssueDraftId, saved.draftId); assert.equal(f.writes(), 2);
});
test('cancel then recreate replaces only the cancelled predecessor and retains both records', async t => {
  const f = sourceFixture(), router = await createCommunityHttpRouter(f.deps); t.after(() => router.stop());
  const first = await router.forwardOwner(f.request); assert.equal(first.status, 200); const old = first.body.draft.draftId;
  assert.equal((await router.forwardOwner({ principal, method: 'POST', path: `github/community-issue-drafts/by-id/${old}/cancel` })).status, 200);
  const next = await router.forwardOwner(f.request); assert.equal(next.status, 200); assert.notEqual(next.body.draft.draftId, old);
  assert.equal(f.source.communityIssueDraftId, next.body.draft.draftId);
  assert.equal((await new SdkCommunityIssueDraftStore(f.deps.storage).getById(old))?.status, 'cancelled');
});

test('changed source cannot silently rebase an unlinked draft or override an unknown source link', async t => {
  const f = sourceFixture(); f.fail(true); const router = await createCommunityHttpRouter(f.deps); t.after(() => router.stop());
  assert.equal((await router.forwardOwner(f.request)).status, 502);
  const store = new SdkCommunityIssueDraftStore(f.deps.storage), before = await store.getBySourceId(f.source.issueId); assert.ok(before);
  f.fail(false); f.source.sourceRevision = 'source-r2';
  const changed = await router.forwardOwner(f.request); assert.equal(changed.status, 409); assert.equal(f.writes(), 1);
  assert.deepEqual(await store.getById(before.draftId), before);
  f.source.sourceRevision = 'source-r1';
  const other = await store.create({ sourceType: 'cat_initiated', sourceId: 'unrelated', userId: 'owner', threadId: 'thread', title: 'Other', bodyMarkdown: '', labels: [], targetRepo: 'org/repo' });
  await store.cancel(other.draftId); f.source.communityIssueDraftId = other.draftId;
  assert.equal((await router.forwardOwner(f.request)).status, 409); assert.equal(f.writes(), 1);
  assert.equal(f.source.communityIssueDraftId, other.draftId);
});
test('source conflict is explicit and does not discard the recoverable private draft', async t => {
  const f = sourceFixture(); f.port.linkDraft = async () => ({ outcome: 'conflict' });
  const router = await createCommunityHttpRouter(f.deps); t.after(() => router.stop());
  const result = await router.forwardOwner(f.request); assert.equal(result.status, 409); assert.match(result.body.error, /conflict/);
  assert.ok(await new SdkCommunityIssueDraftStore(f.deps.storage).getBySourceId(f.source.issueId)); assert.equal(f.source.communityIssueDraftId, null);
});
for (const stopped of [false, true]) test(`late source link cannot report success after ${stopped ? 'stop' : 'cancellation'}`, async t => {
  const f = sourceFixture(); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const link = f.port.linkDraft; f.port.linkDraft = async input => { entered(); await gate; return link(input); };
  const router = await createCommunityHttpRouter(f.deps); t.after(() => router.stop());
  const pending = router.forwardOwner(f.request); await started;
  const store = new SdkCommunityIssueDraftStore(f.deps.storage), draft = await store.getBySourceId(f.source.issueId); assert.ok(draft);
  let stop: Promise<void> | undefined;
  if (stopped) stop = router.stop(); else await store.cancel(draft.draftId);
  release(); const result = await pending; assert.notEqual(result.status, 200); await stop;
  assert.equal((await store.getById(draft.draftId))?.status, stopped ? 'draft' : 'cancelled');
});
test('concurrent source retries reuse one draft through a lost private CAS acknowledgement', async t => {
  const f = sourceFixture(), cas = f.deps.storage.compareAndSet; let lost = true;
  f.deps.storage.compareAndSet = async (key, revision, value) => {
    const result = await cas(key, revision, value);
    if (result.applied && lost && key.startsWith('community.workflow.draft-source.')) { lost = false; throw new Error('private reply lost'); }
    return result;
  };
  const a = await createCommunityHttpRouter(f.deps), b = await createCommunityHttpRouter(f.deps); t.after(() => Promise.all([a.stop(), b.stop()]));
  const results = await Promise.all([a.forwardOwner(f.request), b.forwardOwner(f.request)]);
  assert.ok(results.every(r => r.status === 200)); assert.equal(results[0]!.body.draft.draftId, results[1]!.body.draft.draftId);
  assert.equal(f.source.communityIssueDraftId, results[0]!.body.draft.draftId);
});
test('embedded source call retains the separate Host owner async context', async t => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const owner = new AsyncLocalStorage<string>(); const f = sourceFixture(); const read = f.port.getSource, link = f.port.linkDraft;
  f.port.getSource = async () => { assert.equal(owner.getStore(), 'host-owner'); return read(); };
  f.port.linkDraft = async input => { assert.equal(owner.getStore(), 'host-owner'); return link(input); };
  const router = await createCommunityHttpRouter(f.deps); t.after(() => router.stop());
  assert.equal((await owner.run('host-owner', () => router.forwardOwner(f.request))).status, 200);
});

for (const changedSource of [false, true]) for (const status of ['publishing', 'published'] as const) test(`linked ${status} source draft survives router restart as read-only recovery (source changed: ${changedSource})`, async t => {
  const f = sourceFixture(); let router = await createCommunityHttpRouter(f.deps); t.after(() => router.stop());
  const created = await router.forwardOwner(f.request); assert.equal(created.status, 200);
  const store = new SdkCommunityIssueDraftStore(f.deps.storage), draft = created.body.draft;
  await store.beginPublish(draft.draftId, draft.title, draft.bodyMarkdown);
  if (status === 'published') await store.publish({ draftId: draft.draftId, githubIssueNumber: 42, githubIssueUrl: 'https://github.com/org/repo/issues/42' });
  const before = await store.getById(draft.draftId), writes = f.writes();
  await router.stop(); router = await createCommunityHttpRouter(f.deps);
  let privateWrites = 0; const cas = f.deps.storage.compareAndSet;
  f.deps.storage.compareAndSet = async (...args) => { privateWrites++; return cas(...args); };
  if (changedSource) f.source.sourceRevision = 'source-r2';
  const recovered = await router.forwardOwner(f.request);
  assert.equal(recovered.status, 409); assert.deepEqual(recovered.body.draft, before);
  assert.equal(f.source.communityIssueDraftId, draft.draftId); assert.equal(f.writes(), writes);
  assert.equal(privateWrites, 0); assert.deepEqual(await store.getBySourceId(f.source.issueId), before);
});
for (const mismatch of ['link', 'user', 'thread'] as const) test(`publication recovery refuses ${mismatch} mismatch without returning a draft`, async t => {
  const f = sourceFixture(), router = await createCommunityHttpRouter(f.deps); t.after(() => router.stop());
  const created = await router.forwardOwner(f.request), draft = created.body.draft;
  const store = new SdkCommunityIssueDraftStore(f.deps.storage);
  await store.beginPublish(draft.draftId, draft.title, draft.bodyMarkdown);
  if (mismatch === 'link') f.source.communityIssueDraftId = null;
  if (mismatch === 'user') f.source.userId = 'other';
  if (mismatch === 'thread') f.source.threadId = 'other';
  const recovered = await router.forwardOwner(f.request);
  assert.equal(recovered.status, mismatch === 'user' ? 403 : 409);
  assert.equal(recovered.body.draft, undefined); assert.equal(f.writes(), 1);
});

test('publication beginning during link returns the durable recovery ID without another link', async t => {
  const f = sourceFixture(), store = new SdkCommunityIssueDraftStore(f.deps.storage), link = f.port.linkDraft;
  f.port.linkDraft = async input => {
    const result = await link(input), draft = await store.getById(input.draftId); assert.ok(draft);
    await store.beginPublish(draft.draftId, draft.title, draft.bodyMarkdown);
    return result;
  };
  const router = await createCommunityHttpRouter(f.deps); t.after(() => router.stop());
  const result = await router.forwardOwner(f.request);
  assert.equal(result.status, 409); assert.equal(result.body.draft.status, 'publishing');
  assert.equal(result.body.draft.draftId, f.source.communityIssueDraftId); assert.equal(f.writes(), 1);
});

test('native report reaches the bounded provider reader and records only verified issue evidence', async t => {
  const deps = options(); let calls = 0;
  const url = 'https://github.com/org/repo/issues/1#issuecomment-42';
  const provider: CommunityHttpRouterOptions['provider'] = { token: async () => 'isolated-native-report', execFileAsync: async (_file, args) => {
    calls++; assert.equal(args[1], 'https://api.github.com/repos/org/repo/issues/comments/42');
    return { stdout: JSON.stringify({ id: 42, html_url: url, issue_url: 'https://api.github.com/repos/org/repo/issues/1', body: 'Fixed and released' }) };
  } };
  Object.assign(deps, { provider });
  await new SdkCommunityRepoConfigStore(deps.storage).upsert({ repo: 'org/repo', guardThreadId: 'thread', guardCatId: 'assigned' });
  const store = new SdkCommunityWorkflowIssueStore(deps.storage);
  const issue = (await store.create({ repo: 'org/repo', issueNumber: 1, issueType: 'bug', title: 'Bug' }))!;
  await store.update(issue.id, { assignedCatId: 'assigned', assignedThreadId: 'thread', state: 'accepted' });
  await new SdkCommunityObjectStore(deps.storage).save({ repo: 'org/repo', type: 'issue', number: 1, subjectKey: 'issue:org/repo#1', state: 'fixed', ownerThreadId: 'thread', ownerRole: 'case-owner', nextOwner: 'role', lastExternalActivityAt: null, lastPublicCommentAt: null, linkedIssues: [], linkedPrs: [], closureWaiver: null, issueFixEvidence: null, externalReview: null, appliedEventCount: 0, lastRejectedEvent: null, deliveryCursor: null, createdAt: 1, updatedAt: 1 });
  const router = await createCommunityHttpRouter(deps); t.after(() => router.stop());
  const caller = { catId: 'assigned', userId: 'owner', threadId: 'thread', invocationId: 'inv', assertCurrent: async () => {} };
  const result = await router.invokeNative('github.community.report', { id: issue.id, payload: { publicCommentUrl: url } }, caller);
  assert.equal(result.status, 200); assert.equal(calls, 1);
  assert.equal((await new SdkCommunityObjectStore(deps.storage).get('issue:org/repo#1'))?.state, 'reported');
});

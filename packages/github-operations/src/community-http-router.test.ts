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
  const storage=memoryStorage();
  return {
    storage,
    threads: { get: async () => null, create: async () => { throw new Error('unexpected thread creation'); } },
    projectionOperations: new CommunityProjectionOperations(),
    issues: {

      taskStore: { listByKind: async () => [], getBySubject: async () => null, upsertBySubject: async () => { throw new Error('unexpected tracking'); }, delete: async () => false },
    },
    drafts: {
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
  assert.equal((await b.forwardOwner(request)).status, 409);
  await assert.rejects(store.cancel(draft.draftId), /not draft/);
  await assert.rejects(store.updateContent(draft.draftId, 'other', 'other'), /not draft/);
  release(); assert.equal((await pending).status, 409);
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

for (const explicitNewThread of [false,true]) test(`real resolve route recreates after a lost ordinary create response (explicit=${explicitNewThread})`,async t=>{
  let creates=0,lost=true;const rows=new Map<string,import('@clowder-ai/plugin-sdk').PluginThreadSummary>();
  const deps:CommunityHttpRouterOptions={...options(),threads:{get:async id=>rows.get(id)??null,create:async({title})=>{
    const id=`thread-${++creates}`,row={id,title,deepLinkUrl:'/threads/'+id,createdAt:1,lastActiveAt:1,preferredCats:[],featureRefs:[]};rows.set(id,row);
    if(lost){lost=false;throw new Error('Host response lost');}return row;
  }}};
  const store=new SdkCommunityWorkflowIssueStore(deps.storage),issue=(await store.create({repo:'org/repo',issueNumber:23,issueType:'bug',title:'Retry routing'}))!;
  await store.update(issue.id,{state:'pending-decision'});
  let router=await createCommunityHttpRouter(deps);t.after(()=>router.stop());
  const request={principal,method:'POST',path:`github/community-issues/${issue.id}/resolve`,body:{decision:'accepted',...(explicitNewThread?{routeRecommendation:{kind:'new-thread'}}:{})}};
  assert.equal((await router.forwardOwner(request)).status,500);assert.equal((await store.get(issue.id))?.state,'pending-decision');
  await router.stop();router=await createCommunityHttpRouter(deps);assert.equal((await router.forwardOwner(request)).status,200);
  assert.equal(creates,2);assert.equal((await store.get(issue.id))?.assignedThreadId,'thread-2');
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

test('owner draft POST uses explicit content and the same plugin-private draft identity',async t=>{
 const deps=options(), router=await createCommunityHttpRouter(deps);t.after(()=>router.stop());
 const body={requestId:'feedback-1',repo:'org/repo',title:'Explicit report',bodyMarkdown:'User supplied public text',labels:['bug']};
 const request={principal,method:'POST',path:'github/community-issue-drafts',body};
 const created=await router.forwardOwner(request), retried=await router.forwardOwner(request);
 assert.equal(created.status,200);assert.equal(created.body.data.id,retried.body.data.id);
 assert.equal(created.body.data.bodyMarkdown,body.bodyMarkdown);
 assert.equal(Object.hasOwn(created.body.data,'sourceRevision'),false);
 assert.equal((await router.forwardOwner({...request,body:{...body,title:'Different content'}})).status,409);
 assert.equal((await router.forwardOwner({...request,body:{...body,sourceId:'Host source'}})).status,400);
 assert.equal((await router.forwardOwner({...request,path:'github/community-issue-drafts/from-frustration-issue/feedback-1'})).status,404);
 assert.deepEqual((await router.forwardOwner({principal,method:'GET',path:'github/community-issue-drafts/config'})).body,{defaultRepo:'org/repo',repos:['org/repo']});
});

test('owner-created native draft supports the existing thread preview, edits and publication replay', async t => {
  const deps = options(); let creates = 0;
  deps.drafts.publisher = { create: async draft => {
    creates++; assert.equal(draft.title, 'Edited title'); assert.equal(draft.bodyMarkdown, 'Edited public body');
    return { number: 7, url: 'https://github.com/org/repo/issues/7' };
  }, find: async () => null };
  const router = await createCommunityHttpRouter(deps); t.after(() => router.stop());
  const created = await router.forwardOwner({ principal, method: 'POST', path: 'github/community-issue-drafts',
    body: { requestId: 'preview-1', repo: 'org/repo', title: 'Original', bodyMarkdown: 'Original body' } });
  assert.equal(created.status, 200);
  const path = `github/community-issue-drafts/by-id/${created.body.data.id}`;
  const preview = await router.forwardOwner({ principal, method: 'GET', path });
  assert.equal(preview.status, 200); assert.equal(preview.body.draft.draftId, created.body.data.id);
  assert.equal(preview.body.draft.targetRepo, 'org/repo');
  const request = { principal, method: 'POST', path: `${path}/publish`, body: { title: 'Edited title', bodyMarkdown: 'Edited public body' } };
  const published = await router.forwardOwner(request);
  assert.equal(published.status, 200); assert.equal(published.body.draft.status, 'published');
  assert.equal(published.body.draft.githubIssueNumber, 7);
  assert.equal((await router.forwardOwner(request)).body.draft.githubIssueNumber, 7); assert.equal(creates, 1);
  const recreated = await router.forwardOwner({ principal, method: 'POST', path: 'github/community-issue-drafts',
    body: { requestId: 'preview-1', repo: 'org/repo', title: 'Original', bodyMarkdown: 'Original body' } });
  assert.equal(recreated.status, 200, 'a remounted source card must rediscover its edited draft');
  assert.equal(recreated.body.data.id, created.body.data.id); assert.equal(recreated.body.data.status, 'published');
});

test('cat draft card content is accepted without treating source fields as Host ownership', async t => {
  const deps = options(), router = await createCommunityHttpRouter(deps); t.after(() => router.stop());
  const request = { principal, method: 'POST', path: 'github/community-issue-drafts', body: {
    sourceType: 'cat_initiated', sourceId: 'block-1', threadId: 'message-1', messageId: 'message-1',
    title: 'Cat proposal', bodyMarkdown: 'Selected public content', targetRepo: 'org/repo', labels: ['bug'],
  } };
  const created = await router.forwardOwner(request);
  assert.equal(created.status, 200); assert.equal(created.body.draft.title, 'Cat proposal');
  assert.equal(created.body.draft.draftId, (await router.forwardOwner(request)).body.draft.draftId);
  assert.equal((await router.forwardOwner({ ...request, body: { ...request.body, userId: 'another-owner' } })).status, 400);
  const second = await router.forwardOwner({ ...request, body: { ...request.body, messageId: 'message-2' } });
  assert.notEqual(second.body.draft.draftId, created.body.draft.draftId);
  const path = `github/community-issue-drafts/by-id/${created.body.draft.draftId}`;
  assert.equal((await router.forwardOwner({ principal, method: 'POST', path: `${path}/cancel` })).body.draft.status, 'cancelled');
  assert.equal((await router.forwardOwner({ principal, method: 'POST', path: `${path}/publish`, body: {} })).status, 409);
});

test('native thread publication survives an uncertain response and freezes edits before retry', async t => {
  const deps = options(); let creates = 0, finds = 0;
  deps.drafts.publisher = { create: async () => { creates++; throw new Error('connection lost after POST'); },
    find: async () => { finds++; return { number: 9, url: 'https://github.com/org/repo/issues/9' }; } };
  const native = new NativeIssueDraftRuntime({ storage: deps.storage, config: { get: async () => 'org/repo' } }, deps.drafts.publisher);
  t.after(() => native.stop());
  const created = await native.create({ requestId: 'already-saved', repo: 'org/repo', title: 'Previously saved', bodyMarkdown: 'Public body' });
  let router = await createCommunityHttpRouter(deps); t.after(() => router.stop());
  const path = `github/community-issue-drafts/by-id/${created.data.id}`;
  assert.equal((await router.forwardOwner({ principal, method: 'GET', path })).body.draft.title, 'Previously saved');
  const request = { principal, method: 'POST', path: `${path}/publish`, body: {} };
  const uncertain = await router.forwardOwner(request);
  assert.equal(uncertain.status, 409, 'an unconfirmed publication must not be HTTP-success for existing Host previews');
  assert.match(uncertain.body.error, /uncertain/i);
  assert.equal(uncertain.body.draft.status, 'publishing'); assert.equal(creates, 1);
  assert.equal((await router.forwardOwner({ ...request, body: { title: 'Changed after POST' } })).status, 409);
  assert.equal((await router.forwardOwner({ principal, method: 'POST', path: `${path}/cancel` })).status, 409);
  await router.stop(); router = await createCommunityHttpRouter(deps);
  const retried = await router.forwardOwner(request);
  assert.equal(retried.body.draft.status, 'published'); assert.equal(retried.body.draft.githubIssueNumber, 9);
  assert.equal(creates, 1); assert.equal(finds, 1);
  assert.equal((await router.forwardOwner({ principal, method: 'GET', path: `github/community-issue-drafts/by-id/${'f'.repeat(64)}` })).status, 404);
});

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { terminalFixture, terminalSnapshot, subject, target, head, oldHead, time, nativeHistory } from '../test/terminal-fixture.js';
import type { CommunityEvent } from './business/model/index.js';
import { providerObservation } from './community-read-model.js';
import { mergeTerminalFacts, parseTerminalFacts } from './business/domains/community/terminal-provider-facts.js';
import { TerminalFactCollection } from './terminal-fact-collection.js';
import { runCommunityReconciliation } from './business/domains/community/reconciliation/CommunityReconcilerTaskSpec.js';
import { GitHubProvider } from './github-provider.js';

for (const kind of ['case.declined', 'pr.closed', 'pr.merged'] as const) test(`${kind} fences CI, cloud and assignment through observe then collect`, async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  await f.community.configs.upsert({ repo: target.repoFullName, guardThreadId: 'guard', guardCatId: 'guard', reviewMode: 'maintainer_review' });
  const terminal: CommunityEvent = { sourceEventId: 'native-end-' + kind, subjectKey: subject, kind,
    classification: 'state-changing', payload: {}, at: 100 };
  await f.community.events.append(terminal); await f.projector.apply(terminal);
  const before = (await f.community.objects.get(subject))!.externalReview;
  const snapshot = { state: 'open' as const, headSha: head, ci: 'pass' as const, comments: [], reviews: [],
    cloudObservation: { headSha: head, status: 'clean' as const, reviewId: 10 } };
  await f.community.observeTracking({ ...target, catId: 'new-cat', threadId: 'new-thread' }, snapshot);
  await f.community.collectTracking({ ...target, catId: 'new-cat', threadId: 'new-thread' }, snapshot);
  const after = (await f.community.objects.get(subject))!.externalReview;
  assert.deepEqual(nativeHistory(after), nativeHistory(before));
  assert.equal(after?.lifecycle, 'terminal'); assert.equal(after?.reviewerCatId, 'original-cat');
  assert.equal(after?.wake, null); assert.equal(after?.pendingVerdict, null); assert.equal(f.sends(), 0);
  assert.equal((await f.community.events.read(subject)).filter(event => event.kind.startsWith('case.')).length, kind === 'case.declined' ? 4 : 3);
});

test('old open/close observations cannot reverse a proven new provider period; unchanged open reads coalesce', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  await f.community.collectTracking(target, { state: 'closed', observedAt: time + 2000, comments: [], reviews: [] });
  const before = await f.community.events.read(subject);
  const open = { state: 'open' as const, headSha: head, ci: 'pass' as const, comments: [], reviews: [] };
  await f.community.collectTracking(target, { ...open, observedAt: time + 1000 });
  assert.deepEqual(await f.community.events.read(subject), before);
  await f.community.collectTracking(target, { ...open, observedAt: time + 3000,
    providerUpdatedAt: new Date(time + 3000).toISOString() });
  const reopened = await f.community.events.read(subject);
  await f.community.collectTracking(target, { ...open, observedAt: time + 4000,
    providerUpdatedAt: new Date(time + 3000).toISOString() });
  await f.projector.rebuild(subject);
  await f.community.collectTracking(target, terminalSnapshot());
  assert.deepEqual(await f.community.events.read(subject), reopened, 'old closure is not historical enrollment');
  const fresh = terminalSnapshot();
  await f.community.collectTracking(target, { ...fresh, observedAt: time + 6000, terminalFacts: { ...fresh.terminalFacts!,
    observedAt: time + 6000, closedAt: new Date(time + 5000).toISOString(), mergedAt: new Date(time + 5000).toISOString(),
    ci: { ...fresh.terminalFacts!.ci!, observedAt: time + 6000 } } });
  assert.equal((await f.community.objects.get(subject))?.terminalFacts?.ci?.status, 'pass');
  assert.equal((await f.community.events.read(subject)).filter(event => event.kind === 'pr.open_observed').length, 1);
});

test('API-only old evidence remains inspectable while current open and sparse new merge display unknown CI', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  const collector = new TerminalFactCollection(f.storage, f.community.events, f.projector, f.community.projectionOperations);
  const closed = terminalSnapshot('closed').terminalFacts!;
  await collector.collect(subject, [], closed);
  await f.community.collectTracking(target, { state: 'open', headSha: head, observedAt: time + 10000,
    providerUpdatedAt: new Date(time + 10000).toISOString(), ci: 'pass', comments: [], reviews: [] });
  let view = providerObservation(subject, await f.community.events.read(subject), await f.community.objects.get(subject));
  assert.equal(view.state, 'open'); assert.equal(view.ci, 'unknown'); assert.equal(view.terminalFacts, undefined);
  assert.equal(view.historicalTerminalFacts?.ci?.status, 'pass');
  const merged = { ...closed, state: 'merged' as const, source: 'github-webhook' as const,
    closedAt: new Date(time + 20000).toISOString(), mergedAt: new Date(time + 20000).toISOString(),
    mergeCommitSha: 'c'.repeat(40), reviews: [], ci: null, observedAt: time + 20000 };
  await collector.collect(subject, [], merged); await f.projector.rebuild(subject);
  view = providerObservation(subject, await f.community.events.read(subject), await f.community.objects.get(subject));
  assert.equal(view.state, 'merged'); assert.equal(view.ci, 'unknown'); assert.equal(view.finalReviews?.length, 1);
  assert.equal(view.terminalFacts?.ciHistory?.[0]?.observedAt, closed.ci!.observedAt);
  assert.equal((await f.community.objects.get(subject))?.externalReview?.ci, null);
});

test('new-head periods retain old CI only as history; same-period merge enrichment retains current source-bound CI', () => {
  const old = terminalSnapshot('closed').terminalFacts!;
  const merge = { ...old, state: 'merged' as const, headSha: oldHead, reviews: [], ci: null,
    closedAt: new Date(time + 20000).toISOString(), mergedAt: new Date(time + 20000).toISOString(),
    mergeCommitSha: 'c'.repeat(40), source: 'github-webhook' as const, observedAt: time + 20000 };
  const changed = mergeTerminalFacts(old, merge);
  assert.equal(changed.ci, null); assert.equal(changed.ciHistory?.[0]?.headSha, head);
  assert.equal(changed.reviews[0]?.commitId, head);
  const samePeriod = mergeTerminalFacts(old, { ...merge, headSha: head, closedAt: old.closedAt, mergedAt: old.closedAt });
  assert.equal(samePeriod.ci?.status, 'pass');
  assert.throws(() => parseTerminalFacts({ ...changed, ciHistory: [{ ...old.ci!, checkRollup: 'empty', checks: [] }] }, subject));
});

test('signed reopen delivery verifies current provider state; an old delivery cannot enroll closed history', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  await f.community.configs.upsert({ repo: target.repoFullName, guardThreadId: 'guard', guardCatId: 'guard' });
  await f.community.collectTracking(target, { state: 'closed', comments: [], reviews: [] });
  let currentOpen = false;
  Object.assign(f.community, { provider: { selfLogin: () => 'owner', state: async () => currentOpen
    ? { state: 'open', headSha: head, observedAt: time + 10000, providerUpdatedAt: new Date(time + 10000).toISOString(), closedAt: null, mergedAt: null }
    : { state: 'closed', closedAt: new Date(time).toISOString(), mergedAt: null } } });
  const body = { action: 'reopened', repository: { full_name: target.repoFullName }, pull_request: {
    number: 12, html_url: 'https://github.com/example/project/pull/12' } };
  const rawBody = Buffer.from(JSON.stringify(body));
  const call = (id: string) => f.community.webhook({ method: 'POST', rawBody, headers: { 'x-github-event': 'pull_request',
    'x-github-delivery': id, 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'isolated-test-secret').update(rawBody).digest('hex') } });
  const before = await f.community.events.read(subject);
  assert.equal((await call('old-reopen')).status, 200); assert.deepEqual(await f.community.events.read(subject), before);
  currentOpen = true; assert.equal((await call('current-reopen')).status, 200);
  assert.equal((await f.community.objects.get(subject))?.providerOpen?.headSha, head);
  assert.equal((await f.community.objects.get(subject))?.terminalFacts, undefined);
  assert.equal(f.sends(), 0);
});

test('the first quiet repository baseline records a new opening and the next run captures its new merge', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  await f.community.configs.upsert({ repo: target.repoFullName, guardThreadId: 'guard', guardCatId: 'guard' });
  await f.community.collectTracking(target, { state: 'closed', comments: [], reviews: [] });
  const native = (await f.community.objects.get(subject))?.externalReview;
  let open = true;
  Object.assign(f.community, { provider: { selfLogin: () => 'owner', state: async (_repo: string, _kind: string, _number: number, _signal: AbortSignal, include: boolean) => {
    if (open) return { state: 'open', headSha: head, observedAt: time + 10000,
      providerUpdatedAt: new Date(time + 10000).toISOString(), closedAt: null, mergedAt: null };
    assert.equal(include, true, 'the new period is enrolled by its own observed opening');
    const facts = { ...terminalSnapshot().terminalFacts!, observedAt: time + 30000,
      closedAt: new Date(time + 20000).toISOString(), mergedAt: new Date(time + 20000).toISOString(),
      ci: { ...terminalSnapshot().terminalFacts!.ci!, observedAt: time + 30000 } };
    return { state: 'closed', closedAt: facts.closedAt, mergedAt: facts.mergedAt, terminalFacts: facts };
  } } });
  await f.community.run('community-reconciler');
  const first = await f.community.objects.get(subject);
  assert.equal(first?.providerOpen?.headSha, head); assert.equal(first?.terminalFacts, undefined);
  open = false; await f.community.run('community-reconciler');
  const final = await f.community.objects.get(subject);
  assert.equal(final?.terminalFacts?.state, 'merged'); assert.equal(final?.terminalFacts?.headSha, head);
  assert.deepEqual(nativeHistory(final?.externalReview), nativeHistory(native)); assert.equal(f.sends(), 0);
  await f.projector.rebuild(subject); assert.deepEqual(await f.community.objects.get(subject), final);
});

for (const entry of ['webhook', 'reconciler'] as const) test(`a delayed old closure cannot append lifecycle work after its facts are rejected (${entry})`, async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  await f.community.configs.upsert({ repo: target.repoFullName, guardThreadId: 'guard', guardCatId: 'guard' });
  const collector = new TerminalFactCollection(f.storage, f.community.events, f.projector, f.community.projectionOperations);
  const closed = terminalSnapshot('closed').terminalFacts!;
  await collector.collect(subject, [], closed);
  await f.community.collectTracking(target, { state: 'open', headSha: head, observedAt: time + 10000,
    providerUpdatedAt: new Date(time + 10000).toISOString(), comments: [], reviews: [] });
  const history = await f.community.events.read(subject), before = await f.community.objects.get(subject);
  if (entry === 'webhook') {
    const body = { action: 'closed', repository: { full_name: target.repoFullName }, pull_request: {
      number: 12, title: 'Old close', html_url: 'https://github.com/example/project/pull/12', user: { login: 'contributor' },
      state: 'closed', merged: false, head: { sha: head }, closed_at: closed.closedAt } };
    const rawBody = Buffer.from(JSON.stringify(body));
    assert.equal((await f.community.webhook({ method: 'POST', rawBody, headers: { 'x-github-event': 'pull_request',
      'x-github-delivery': 'delayed-old-close', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'isolated-test-secret').update(rawBody).digest('hex') } })).status, 200);
  } else await runCommunityReconciliation({ terminalCollection: collector,
    objectStore: f.community.objects, eventLog: f.community.events, projector: f.projector, findingStore: f.community.findings,
    fetchIssueState: async () => null, fetchPrState: async () => ({ state: 'closed', closedAt: closed.closedAt,
      mergedAt: null, terminalFacts: closed }), isBaselineEstablished: async () => true,
    markBaselineEstablished: async () => {}, log: { info() {}, warn() {} } }, new AbortController().signal);
  assert.deepEqual(await f.community.events.read(subject), history);
  assert.deepEqual(await f.community.objects.get(subject), before); assert.equal(f.sends(), 0);
});

test('provider open evidence requires the exact PR identity and a complete HEAD', async () => {
  const valid = { state: 'open', number: 12, html_url: 'https://github.com/example/project/pull/12', head: { sha: head } };
  for (const metadata of [{ ...valid, number: 13 }, { ...valid, html_url: 'https://github.com/other/project/pull/12' },
    { ...valid, head: undefined }, { ...valid, number: undefined }, { ...valid, state: 'unknown' }]) {
    const provider = new GitHubProvider({ token: async () => undefined, log: { warn() {} },
      execFileAsync: async () => ({ stdout: JSON.stringify(metadata) }) });
    await assert.rejects(provider.state(target.repoFullName, 'pr', target.number, new AbortController().signal), /subject identity/);
  }
});

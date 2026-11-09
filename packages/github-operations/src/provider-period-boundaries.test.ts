import assert from 'node:assert/strict';
import test from 'node:test';
import { terminalFixture, terminalSnapshot, subject, target, head, time, nativeHistory } from '../test/terminal-fixture.js';
import type { CommunityEvent } from './business/model/index.js';
import { reduceProviderHistory } from './business/domains/community/provider-period.js';
import { shouldObserveTerminalFacts, providerProjectionFields } from './business/domains/community/terminal-provider-facts.js';
import { providerObservation } from './community-read-model.js';
import { TerminalFactCollection } from './terminal-fact-collection.js';
import { TerminalReconciliationRuntime } from './terminal-reconciliation.js';
import { runCommunityReconciliation } from './business/domains/community/reconciliation/CommunityReconcilerTaskSpec.js';

for (const state of ['closed', 'merged'] as const) test(`new summary ${state} owns the current view and leaves old CI as historical evidence`, async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  await f.community.collectTracking(target, terminalSnapshot('closed'));
  const native = (await f.community.objects.get(subject))!.externalReview;
  await f.community.collectTracking(target, { state: 'open', headSha: head, observedAt: time + 10000,
    providerUpdatedAt: new Date(time + 10000).toISOString(), comments: [], reviews: [] });
  await f.community.collectTracking(target, { state, headSha: head, observedAt: time + 20000, comments: [], reviews: [] });
  const projection = await f.community.objects.get(subject), history = await f.community.events.read(subject);
  assert.equal(projection?.providerOpen, undefined);
  assert.equal(projection?.state, state === 'merged' ? 'fixed' : 'closed');
  assert.equal(providerProjectionFields(projection!).state, state);
  const view = providerObservation(subject, history, projection);
  assert.equal(view.state, state); assert.equal(view.ci, 'unknown'); assert.equal(view.terminalFacts, undefined);
  assert.equal(view.historicalTerminalFacts?.ci?.status, 'pass');
  assert.equal(projection?.externalReview?.ci, null);
  assert.deepEqual(nativeHistory(projection?.externalReview), nativeHistory(native));
  await f.projector.rebuild(subject); assert.deepEqual(await f.community.objects.get(subject), projection);
  if (state === 'closed') {
    await f.community.collectTracking(target, { state: 'open', headSha: head, observedAt: time + 15000,
      providerUpdatedAt: new Date(time + 15000).toISOString(), comments: [], reviews: [] });
    assert.deepEqual(await f.community.events.read(subject), history,
      'a summary with no closure clock must not borrow the previous open clock and accept an older reopening');
  }
});

test('two rejected raw opens do not enroll legacy closure or change its replay baseline', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  const close: CommunityEvent = { sourceEventId: 'legacy-clocked-close', subjectKey: subject, kind: 'pr.closed',
    classification: 'state-changing', payload: { closedAt: new Date(time + 5000).toISOString(), providerObservedAt: time + 5000 }, at: time + 5000 };
  await f.community.events.append(close); await f.projector.apply(close);
  for (const delta of [1000, 2000]) {
    const open: CommunityEvent = { sourceEventId: 'raw-old-open-' + delta, subjectKey: subject, kind: 'pr.open_observed',
      classification: 'informational', payload: { headSha: head, observedAt: time + delta,
        providerUpdatedAt: new Date(time + delta).toISOString() }, at: time + delta };
    await f.community.events.append(open); await f.projector.apply(open);
  }
  const history = await f.community.events.read(subject);
  assert.equal(reduceProviderHistory(history).state?.state, 'closed');
  assert.equal(shouldObserveTerminalFacts(history), false);
  const projection = await f.community.objects.get(subject); assert.equal(projection?.providerOpen, undefined);
  assert.equal(providerObservation(subject, history, { ...projection!, providerPeriod: undefined }).state, 'closed',
    'an older cache without the period field must still use the canonical journal decision');
  await f.projector.rebuild(subject); assert.deepEqual(await f.community.objects.get(subject), projection);
});

test('a reopened period cannot reuse old passing CI when provider timestamps share one second', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  const collector = new TerminalFactCollection(f.storage, f.community.events, f.projector, f.community.projectionOperations);
  const original = terminalSnapshot('closed').terminalFacts!;
  await collector.collect(subject, [], { ...original, observedAt: time + 100, ci: { ...original.ci!, observedAt: time + 100 } });
  await f.community.collectTracking(target, { state: 'open', headSha: head, observedAt: time + 500,
    providerUpdatedAt: new Date(time).toISOString(), comments: [], reviews: [] });
  const ambiguous = await collector.collect(subject, [], { ...original, state: 'merged', mergedAt: original.closedAt,
    mergeCommitSha: 'c'.repeat(40), source: 'github-webhook', observedAt: time + 900, reviews: [], ci: null });
  assert.equal(ambiguous.denied, true, 'a coarse webhook clock cannot prove which side of the reopen it belongs to');
  assert.equal((await f.community.objects.get(subject))?.providerPeriod?.state, 'open');
  // A new complete API request proves the same-second merge. Its request clock
  // also accompanies the lifecycle row when the outer snapshot omits it.
  await f.community.collectTracking(target, { ...terminalSnapshot(), terminalFacts: { ...original,
    state: 'merged', mergedAt: original.closedAt, mergeCommitSha: 'c'.repeat(40),
    observedAt: time + 1100, source: 'github-api', reviews: [], ci: null } });
  const projection = await f.community.objects.get(subject);
  const view = providerObservation(subject, await f.community.events.read(subject), projection);
  assert.equal(view.state, 'merged'); assert.equal(view.ci, 'unknown');
  assert.equal(projection?.state, 'fixed');
  assert.equal(view.terminalFacts?.ciHistory?.[0]?.observedAt, time + 100);
  await f.projector.rebuild(subject); assert.deepEqual(await f.community.objects.get(subject), projection);
});

test('new collectors reuse the original lifecycle identity instead of resetting a declined legacy case', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  const initial = terminalSnapshot();
  const snapshot = { ...initial, reviews: [], terminalFacts: { ...initial.terminalFacts!, reviews: [] } };
  const events: CommunityEvent[] = [
    { sourceEventId: 'legacy-terminal-facts', subjectKey: subject, kind: 'pr.terminal_observed', classification: 'informational',
      payload: { terminalFacts: snapshot.terminalFacts }, at: time + 1000 },
    { sourceEventId: 'reconciler:legacy-original-merge', subjectKey: subject, kind: 'pr.merged', classification: 'state-changing',
      payload: { closedAt: snapshot.terminalFacts.closedAt }, at: time + 1000 },
    { sourceEventId: 'owner-declined-after-merge', subjectKey: subject, kind: 'case.declined', classification: 'state-changing', payload: {}, at: time + 2000 },
  ];
  for (const event of events) { await f.community.events.append(event); await f.projector.apply(event); }
  const before = await f.community.objects.get(subject), history = await f.community.events.read(subject);
  await f.community.collectTracking(target, snapshot);
  assert.deepEqual(await f.community.events.read(subject), history);
  assert.deepEqual(await f.community.objects.get(subject), before);
  assert.equal(before?.state, 'declined'); assert.equal(f.sends(), 0);
});

test('a scheduled snapshot prepared before historical repair cannot manufacture a later merge cascade', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  await f.community.configs.upsert({ repo: target.repoFullName, guardThreadId: 'guard', guardCatId: 'guard' });
  const issue = 'issue:example/project#99';
  for (const event of [
    { sourceEventId: 'repair-race-issue', subjectKey: issue, kind: 'issue.opened', payload: {}, classification: 'state-changing', at: 1 },
    { sourceEventId: 'repair-race-pr', subjectKey: subject, kind: 'pr.opened', payload: { body: 'Fixes #99' }, classification: 'state-changing', at: 2 },
    { sourceEventId: 'repair-race-legacy-close', subjectKey: subject, kind: 'pr.closed', payload: {}, classification: 'state-changing', at: 3 },
  ] as CommunityEvent[]) { await f.community.events.append(event); await f.projector.apply(event); }
  const native = (await f.community.objects.get(subject))!.externalReview;
  const issueBefore = await f.community.objects.get(issue), issueHistory = await f.community.events.read(issue);
  const snapshot = terminalSnapshot(), facts = snapshot.terminalFacts!;
  const repair = new TerminalReconciliationRuntime({ storage: f.storage, provider: { read: async () => snapshot }, projectionOperations: f.community.projectionOperations });
  t.after(() => repair.stop());
  const collector = new TerminalFactCollection(f.storage, f.community.events, f.projector, f.community.projectionOperations);
  let repaired = false;
  await runCommunityReconciliation({ objectStore: f.community.objects, eventLog: f.community.events, projector: f.projector,
    findingStore: f.community.findings, fetchIssueState: async () => ({ state: 'open', closedAt: null, mergedAt: null }),
    fetchPrState: async () => ({ state: 'closed', closedAt: facts.closedAt, mergedAt: facts.mergedAt, terminalFacts: facts }),
    terminalCollection: { collect: async (...args: Parameters<TerminalFactCollection['collect']>) => {
      if (!repaired) { repaired = true; await repair.reconcile({ subjectKey: subject }, { userId: 'owner', catId: 'cat', threadId: 'thread',
        invocationId: 'repair-race', assertCurrent: async () => {} }); }
      return collector.collect(...args);
    } } as TerminalFactCollection,
    isBaselineEstablished: async () => true, markBaselineEstablished: async () => {}, log: { info() {}, warn() {} },
  }, new AbortController().signal);
  assert.equal(repaired, true);
  assert.equal((await f.community.objects.get(subject))?.state, 'closed');
  assert.deepEqual(await f.community.objects.get(issue), issueBefore);
  assert.deepEqual(await f.community.events.read(issue), issueHistory);
  assert.deepEqual(nativeHistory((await f.community.objects.get(subject))?.externalReview), nativeHistory(native));
  assert.equal(f.sends(), 0);
});

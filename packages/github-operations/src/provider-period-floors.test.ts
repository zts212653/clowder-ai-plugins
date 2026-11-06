import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { terminalFixture, terminalSnapshot, subject, target, head, time, nativeHistory } from '../test/terminal-fixture.js';
import { TerminalFactCollection } from './terminal-fact-collection.js';
import { providerObservation } from './community-read-model.js';
import { providerProjectionFields } from './business/domains/community/terminal-provider-facts.js';
import { reduceProviderHistory } from './business/domains/community/provider-period.js';
import { GitHubRepoWebhookHandler } from './business/infrastructure/connectors/github-repo-event/GitHubRepoWebhookHandler.js';
import { communityProgressKey } from './legacy-repository-progress.js';
import type { CommunityEvent } from './business/model/index.js';
import { runCommunityReconciliation } from './business/domains/community/reconciliation/CommunityReconcilerTaskSpec.js';

const at = (delta: number) => new Date(time + delta).toISOString();
const opened = (delta: number, updatedAt?: string) => ({ state: 'open' as const, headSha: head,
  observedAt: time + delta, ...(updatedAt ? { providerUpdatedAt: updatedAt } : {}), comments: [], reviews: [] });
const collection = (f: Awaited<ReturnType<typeof terminalFixture>>) =>
  new TerminalFactCollection(f.storage, f.community.events, f.projector, f.community.projectionOperations);

test('a summary closure retains prior clock floors and rejects previous-period facts and reopening', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  await f.community.collectTracking(target, terminalSnapshot('closed'));
  await f.community.collectTracking(target, opened(10000, at(10000)));
  await f.community.collectTracking(target, { state: 'closed', headSha: head, observedAt: time + 20000, comments: [], reviews: [] });
  const before = await f.community.objects.get(subject), history = await f.community.events.read(subject);
  const result = await collection(f).collect(subject, [], { ...terminalSnapshot('closed').terminalFacts!, observedAt: time + 2000 });
  assert.equal(result.denied, true);
  await f.community.collectTracking(target, opened(5000, at(5000)));
  assert.deepEqual(await f.community.events.read(subject), history);
  assert.deepEqual(await f.community.objects.get(subject), before);
  assert.equal(before?.providerPeriod?.floorObservedAt, time + 10000);
  assert.equal(before?.providerPeriod?.floorUpdatedAt, at(10000));
  const view = providerObservation(subject, history, before);
  assert.equal(view.state, 'closed'); assert.equal(view.ci, 'unknown');
  assert.equal(view.historicalTerminalFacts?.ci?.status, 'pass');
  await f.projector.rebuild(subject); assert.deepEqual(await f.community.objects.get(subject), before);
});

for (const sameSecond of [false, true]) test(`a delayed signed close cannot reverse a reopened period (${sameSecond ? 'same second' : 'missing server clock'})`, async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  const original = terminalSnapshot('closed').terminalFacts!;
  await collection(f).collect(subject, [], { ...original, observedAt: time + 100 });
  await f.community.collectTracking(target, sameSecond ? opened(500, at(0)) : opened(10000));
  const history = await f.community.events.read(subject), before = await f.community.objects.get(subject);
  let deliveries = 0;
  const collector = collection(f);
  const handler = new GitHubRepoWebhookHandler({ webhookSecret: 'isolated-test-secret', repoAllowlist: [target.repoFullName] }, {
    eventLog: f.community.events, projector: f.projector, mayObserveTerminalFacts: key => collector.allowed(key),
    collectTerminalFacts: async facts => !(await collector.collect(subject, [], facts)).denied,
    dedup: { claim: async () => true, confirm: async () => {}, rollback: async () => {} },
    deliver: async () => { deliveries++; return { messageId: 'unexpected-old-close' }; },
  });
  const body = { action: 'closed', repository: { full_name: target.repoFullName }, pull_request: {
    number: 12, title: 'Delayed close', html_url: 'https://github.com/example/project/pull/12', user: { login: 'contributor' },
    state: 'closed', merged: false, head: { sha: head }, closed_at: at(0), body: 'Old period' } };
  const raw = Buffer.from(JSON.stringify(body));
  const result = await handler.handleWebhook(body, { 'x-github-event': 'pull_request', 'x-github-delivery': 'r6-' + sameSecond,
    'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'isolated-test-secret').update(raw).digest('hex') }, raw);
  assert.equal(result.kind, 'processed'); assert.equal(deliveries, 0);
  assert.deepEqual(await f.community.events.read(subject), history);
  assert.deepEqual(await f.community.objects.get(subject), before);
  assert.equal(providerProjectionFields(before!).state, 'open');
  await f.projector.rebuild(subject); assert.deepEqual(await f.community.objects.get(subject), before);
});

test('same-second previous-period CI cannot fill a later closure', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  const collector = collection(f), original = terminalSnapshot('closed').terminalFacts!;
  await collector.collect(subject, [], { ...original, observedAt: time + 100, ci: { ...original.ci!, observedAt: time + 100 } });
  await f.community.collectTracking(target, opened(500, at(0)));
  await collector.collect(subject, [], { ...original, observedAt: time + 900, ci: null });
  const before = await f.community.objects.get(subject), history = await f.community.events.read(subject);
  const result = await collector.collect(subject, [], { ...original, observedAt: time + 200,
    ci: { ...original.ci!, observedAt: time + 200 } });
  assert.equal(result.denied, true); assert.deepEqual(await f.community.events.read(subject), history);
  assert.deepEqual(await f.community.objects.get(subject), before);
  assert.equal(providerObservation(subject, history, before).ci, 'unknown');
  await f.projector.rebuild(subject); assert.deepEqual(await f.community.objects.get(subject), before);
});

test('identical facts after reopening record the new closure once rather than coalescing against history', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  const collector = collection(f), original = { ...terminalSnapshot('closed').terminalFacts!, observedAt: time + 100, ci: null };
  await collector.collect(subject, [], original);
  const native = (await f.community.objects.get(subject))!.externalReview;
  await f.community.collectTracking(target, opened(500, at(0)));
  assert.equal((await collector.collect(subject, [], { ...original, observedAt: time + 900 })).recorded, true);
  const before = await f.community.objects.get(subject), history = await f.community.events.read(subject);
  assert.equal(history.filter(event => event.kind === 'pr.terminal_observed').length, 2);
  assert.equal(providerObservation(subject, history, before).state, 'closed');
  assert.equal(providerProjectionFields(before!).state, 'closed');
  assert.deepEqual(nativeHistory(before?.externalReview), nativeHistory(native));
  assert.equal((await collector.collect(subject, [], { ...original, observedAt: time + 1100 })).recorded, false);
  assert.deepEqual(await f.community.events.read(subject), history);
  await f.projector.rebuild(subject); assert.deepEqual(await f.community.objects.get(subject), before);
  assert.equal(f.sends(), 0);
});

test('transition append preserves a checkpoint-advanced floor even if its next checkpoint fails', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  const collector = collection(f), original = terminalSnapshot('closed').terminalFacts!;
  await collector.collect(subject, [], original);
  await f.community.collectTracking(target, opened(5000, at(5000)));
  const previous = await f.community.events.read(subject);
  await f.community.collectTracking(target, opened(10000, at(10000)));
  assert.deepEqual(await f.community.events.read(subject), previous, 'unchanged reads use the bounded checkpoint');
  const key = communityProgressKey('terminal-observation', subject), checkpoint = await f.storage.get(key);
  const interrupted = new TerminalFactCollection({ ...f.storage, set: async (name, value) => {
    if (name === key) throw new Error('checkpoint interrupted'); return f.storage.set(name, value);
  } }, f.community.events, f.projector, f.community.projectionOperations);
  const closing = { ...original, source: 'github-webhook' as const, observedAt: time + 40000,
    closedAt: at(30000), reviews: [], ci: null };
  await assert.rejects(interrupted.collect(subject, [], closing), /checkpoint interrupted/);
  assert.deepEqual(await f.storage.get(key), checkpoint);
  const history = await f.community.events.read(subject);
  const durable = reduceProviderHistory(history).state!;
  assert.equal(durable.floorObservedAt, time + 10000);
  assert.equal(durable.floorUpdatedAt, at(10000));
  assert.equal(durable.observedAt, null, 'a webhook does not borrow the prior open request clock');
  // Remove progress entirely to prove recovery depends on the committed row.
  await f.storage.delete(key);
  const delayed = await collection(f).collect(subject, [], { ...original, closedAt: at(30000), observedAt: time + 7500 });
  assert.equal(delayed.denied, true); assert.deepEqual(await f.community.events.read(subject), history);
  await f.projector.rebuild(subject);
  const rebuilt = await f.community.objects.get(subject);
  assert.equal(providerObservation(subject, history, rebuilt).state, 'closed');
  assert.equal(providerObservation(subject, history, rebuilt).ci, 'unknown');
  assert.equal(f.sends(), 0);
});

test('a pre-floor projection cache reconstructs the journal boundary before accepting its next event', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  const collector = collection(f), original = terminalSnapshot('closed').terminalFacts!;
  await collector.collect(subject, [], { ...original, observedAt: time + 100 });
  await f.community.collectTracking(target, opened(500, at(0)));
  await collector.collect(subject, [], { ...original, observedAt: time + 900, ci: null });
  const before = (await f.community.objects.get(subject))!;
  const { floorObservedAt, floorUpdatedAt, ...oldPeriod } = before.providerPeriod!;
  assert.equal(floorObservedAt, time + 500); assert.equal(floorUpdatedAt, at(0));
  // Simulate persisted bytes written by the previous candidate, before these
  // fields existed. No migration grants historical collection permission.
  await f.community.objects.save({ ...before, providerPeriod: oldPeriod as typeof before.providerPeriod });
  const stale: CommunityEvent = { sourceEventId: 'raw-old-open-after-cache-upgrade', subjectKey: subject,
    kind: 'pr.open_observed', classification: 'informational', payload: { headSha: head,
      observedAt: time + 200, providerUpdatedAt: at(0) }, at: time + 200 };
  await f.community.events.append(stale); await f.projector.apply(stale);
  assert.equal((await f.community.objects.get(subject))?.providerOpen, undefined);
  await collector.collect(subject, [], { ...original, observedAt: time + 1200,
    ci: { ...original.ci!, status: 'fail', observedAt: time + 1200, checks: [{ name: 'gate', bucket: 'fail' }] } });
  const live = await f.community.objects.get(subject);
  assert.equal(live?.providerPeriod?.floorObservedAt, time + 500);
  assert.equal(providerObservation(subject, await f.community.events.read(subject), live).ci, 'fail');
  await f.projector.rebuild(subject); assert.deepEqual(await f.community.objects.get(subject), live);
});

test('scheduled same-second merge uses its complete request clock and still fixes the linked issue', async t => {
  const f = await terminalFixture(); t.after(() => f.community.stop());
  const issue = 'issue:example/project#99';
  for (const event of [
    { sourceEventId: 'floor-issue', subjectKey: issue, kind: 'issue.opened', classification: 'state-changing', payload: {}, at: 1 },
    { sourceEventId: 'floor-pr-link', subjectKey: subject, kind: 'pr.opened', classification: 'state-changing', payload: { body: 'Fixes #99' }, at: 2 },
  ] as CommunityEvent[]) { await f.community.events.append(event); await f.projector.apply(event); }
  const original = terminalSnapshot('closed').terminalFacts!;
  await f.community.collectTracking(target, { ...terminalSnapshot('closed'), terminalFacts: { ...original, observedAt: time + 100, ci: null } });
  const native = (await f.community.objects.get(subject))!.externalReview;
  await f.community.collectTracking(target, opened(500, at(0)));
  const merged = { ...original, state: 'merged' as const, mergedAt: at(0), mergeCommitSha: 'c'.repeat(40),
    observedAt: time + 1100, ci: null };
  await runCommunityReconciliation({ objectStore: f.community.objects, eventLog: f.community.events, projector: f.projector,
    findingStore: f.community.findings, terminalCollection: collection(f),
    fetchIssueState: async () => ({ state: 'open', closedAt: null, mergedAt: null }),
    fetchPrState: async () => ({ state: 'closed', closedAt: at(0), mergedAt: at(0), terminalFacts: merged }),
    isBaselineEstablished: async () => true, markBaselineEstablished: async () => {}, log: { info() {}, warn() {} },
  }, new AbortController().signal);
  const live = await f.community.objects.get(subject);
  assert.equal(live?.state, 'fixed'); assert.equal(live?.providerOpen, undefined);
  assert.equal((await f.community.objects.get(issue))?.state, 'fixed');
  assert.deepEqual(nativeHistory(live?.externalReview), nativeHistory(native));
  await f.projector.rebuild(subject); assert.deepEqual(await f.community.objects.get(subject), live);
  assert.equal(f.sends(), 0);
});

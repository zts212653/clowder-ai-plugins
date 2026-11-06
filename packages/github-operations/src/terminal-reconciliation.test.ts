import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginActionContext } from '@clowder-ai/plugin-sdk';
import { terminalFixture, terminalSnapshot, subject, head, target, nativeHistory } from '../test/terminal-fixture.js';
import { TerminalReconciliationRuntime } from './terminal-reconciliation.js';
import type { GitHubTrackingProvider } from './tracking-runtime.js';
import { CommunityProjector } from './business/domains/community/community-projector.js';
import type { CommunityEvent } from './business/model/index.js';

const caller: PluginActionContext = { catId: 'repair-cat', threadId: 'repair-thread', userId: 'owner', invocationId: 'repair-invocation', assertCurrent: async () => {} };
async function fixture(read: GitHubTrackingProvider['read'] = async () => terminalSnapshot(state), state: 'merged' | 'closed' = 'merged') {
  const f = await terminalFixture();
  await f.community.configs.upsert({ repo: target.repoFullName, guardThreadId: 'guard', guardCatId: 'guard-cat' });
  await f.community.collectTracking(target, { state, comments: [], reviews: [] });
  const runtime = new TerminalReconciliationRuntime({ storage: f.storage, provider: { read }, projectionOperations: f.community.projectionOperations });
  return { ...f, runtime };
}

for (const state of ['merged', 'closed'] as const) test(`${state} terminal repair re-reads one exact subject and preserves native, subscription and refusal history`, async t => {
  let reads = 0;
  const f = await fixture(async requested => { assert.deepEqual(requested, { ...target, catId: caller.catId, threadId: caller.threadId }); reads++; return terminalSnapshot(state); }, state);
  t.after(async () => { await f.runtime.stop(); await f.community.stop(); });
  await f.storage.set('github.wait.existing-done', { status: 'done', generation: 5 });
  await f.storage.set('historical.not-recorded', { outcome: 'not_recorded', code: 'subject_terminal' });
  const original = (await f.community.objects.get(subject))!.externalReview;
  const initialEvents = await f.community.events.read(subject);
  const first = await f.runtime.reconcile({ subjectKey: subject }, caller);
  assert.equal(first.data.outcome, 'recorded'); assert.equal(first.data.terminalFacts?.headSha, head);
  const second = await f.runtime.reconcile({ subjectKey: subject }, caller);
  assert.equal(second.data.outcome, 'unchanged'); assert.deepEqual(second.data.terminalFacts, first.data.terminalFacts);
  assert.equal(reads, 2); assert.equal(f.sends(), 0);
  assert.deepEqual(nativeHistory((await f.community.objects.get(subject))?.externalReview), nativeHistory(original));
  assert.deepEqual((await f.community.events.read(subject)).slice(0, initialEvents.length), initialEvents);
  assert.deepEqual((await f.storage.get('github.wait.existing-done'))?.value, { status: 'done', generation: 5 });
  assert.deepEqual((await f.storage.get('historical.not-recorded'))?.value, { outcome: 'not_recorded', code: 'subject_terminal' });
  assert.equal((await f.community.events.read(subject)).filter(event => event.kind.startsWith('case.')).length, initialEvents.filter(event => event.kind.startsWith('case.')).length);
});

for (const mode of ['pending', 'legacy', 'unapplied'] as const) test(`provider repair never performs unrelated issue work (${mode})`, async t => {
  const f = await terminalFixture();
  await f.community.configs.upsert({ repo: target.repoFullName, guardThreadId: 'guard', guardCatId: 'guard' });
  const issue = 'issue:example/project#99';
  const seed: CommunityEvent = { sourceEventId: 'repair-scope-issue', subjectKey: issue, kind: 'case.bootstrap',
    classification: 'state-changing', payload: { mappedState: 'in_progress' }, at: 1 };
  await f.community.events.append(seed); await f.projector.apply(seed);
  const merge: CommunityEvent = { sourceEventId: 'repair-scope-merge', subjectKey: subject, kind: 'pr.merged',
    classification: 'state-changing', payload: { body: 'Fixes #99' }, at: 2 };
  const stopped = new CommunityProjector(f.community.events, f.community.objects, f.community.projectionOperations);
  Object.assign(stopped, { drainFollowUps: async () => { throw new Error('stopped worker'); } });
  await f.community.events.append(merge);
  if (mode !== 'unapplied') await assert.rejects(stopped.apply(merge), /stopped worker/);
  if (mode === 'legacy') {
    const { journalCursor, pendingFollowUps, ...original } = (await f.community.objects.get(subject))!;
    await f.community.objects.save(original);
  }
  const before = await f.community.objects.get(subject), issueBefore = await f.community.objects.get(issue);
  const history = await f.community.events.read(subject), issueHistory = await f.community.events.read(issue);
  const repair = new TerminalReconciliationRuntime({ storage: f.storage, provider: { read: async () => terminalSnapshot() },
    projectionOperations: f.community.projectionOperations });
  t.after(async () => { await repair.stop(); await f.community.stop(); });
  await repair.reconcile({ subjectKey: subject }, caller);
  await repair.reconcile({ subjectKey: subject }, caller);
  assert.deepEqual(await f.community.objects.get(issue), issueBefore);
  assert.deepEqual(await f.community.events.read(issue), issueHistory);
  const after = await f.community.objects.get(subject);
  if (mode === 'unapplied') assert.deepEqual(after?.pendingFollowUps, [{ sourceEventId: merge.sourceEventId, kind: 'merge-cascade', numbers: [99] }]);
  else assert.deepEqual(after?.pendingFollowUps, before?.pendingFollowUps);
  assert.deepEqual(after?.linkedIssues, [99]);
  assert.equal((await f.community.events.read(subject)).length, history.length + 1);
});

test('missing authentication, supplied facts, unconfigured repo and absent subject cannot reach the provider', async t => {
  let reads = 0; const f = await fixture(async () => { reads++; return terminalSnapshot(); });
  t.after(async () => { await f.runtime.stop(); await f.community.stop(); });
  const before = await f.storage.list();
  await assert.rejects(f.runtime.reconcile({ subjectKey: subject }), /native action context/);
  await assert.rejects(f.runtime.reconcile({ subjectKey: subject, terminalFacts: terminalSnapshot().terminalFacts }, caller));
  await assert.rejects(f.runtime.reconcile({ subjectKey: 'pr:other/project#12' }, caller), /not configured/);
  await assert.rejects(f.runtime.reconcile({ subjectKey: 'pr:example/project#13' }, caller), /terminal subject/);
  await assert.rejects(f.runtime.reconcile({ subjectKey: 'pr:../project#12' }, caller));
  assert.equal(reads, 0); assert.deepEqual(await f.storage.list(), before);
});

test('a foreign, open or incomplete provider result never appends a terminal repair', async t => {
  const good = terminalSnapshot();
  for (const bad of [
    { ...good, state: 'open' as const }, { ...good, commentsComplete: false },
    { ...good, terminalFacts: { ...good.terminalFacts!, subjectKey: 'pr:other/project#12' } },
    { ...good, terminalFacts: { ...good.terminalFacts!, ci: { ...good.terminalFacts!.ci!, headSha: 'f'.repeat(40) } } },
  ]) {
    const f = await fixture(async () => bad); t.after(async () => { await f.runtime.stop(); await f.community.stop(); });
    const before = await f.storage.list();
    await assert.rejects(f.runtime.reconcile({ subjectKey: subject }, caller));
    assert.deepEqual(await f.storage.list(), before);
  }
});

test('invocation expiry, repository revocation and shutdown fence late provider results', async t => {
  for (const mode of ['caller', 'config', 'stop'] as const) {
    let live = true, started!: () => void, release!: () => void;
    const entered = new Promise<void>(r => { started = r; }), blocked = new Promise<void>(r => { release = r; });
    const f = await fixture(async () => { started(); await blocked; return terminalSnapshot(); });
    t.after(async () => { await f.runtime.stop(); await f.community.stop(); });
    const initial = await f.community.events.read(subject);
    const call = assert.rejects(f.runtime.reconcile({ subjectKey: subject }, { ...caller, assertCurrent: async () => { if (!live) throw new Error('expired'); } }));
    await entered;
    let stopping: Promise<void> | undefined;
    if (mode === 'caller') live = false;
    if (mode === 'config') await f.community.configs.deleteByRepo(target.repoFullName);
    if (mode === 'stop') stopping = f.runtime.stop();
    release(); await call; await stopping;
    assert.deepEqual(await f.community.events.read(subject), initial);
  }
});

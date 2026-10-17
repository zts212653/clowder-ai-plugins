import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryStorage } from '../test/memory-storage.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { SdkCommunityObjectStore } from './business/domains/community/CommunityObjectStore.js';
import { SdkCommunityRepoConfigStore } from './business/domains/community/CommunityRepoConfigStore.js';
import { CommunityProjector, CommunityProjectionOperations } from './business/domains/community/community-projector.js';
import { ExternalReviewVerdictService } from './business/domains/community/external-review/ExternalReviewVerdictService.js';

const head = 'a'.repeat(40), subject = 'pr:example/project#12';
const input = { repoFullName: 'example/project', prNumber: 12, reviewedHeadSha: head, verdict: 'approved' as const,
  summary: 'Reviewed', delivery: { kind: 'delivered' as const, githubUrl: 'https://github.com/example/project/pull/12#pullrequestreview-80' },
  principal: { catId: 'cat', threadId: 'thread' }, actionLeaseRef: { leaseId: 'lease', generation: 1 } };
async function fixture() {
  const storage = memoryStorage(), events = new SdkCommunityEventLog(storage), objects = new SdkCommunityObjectStore(storage);
  const configs = new SdkCommunityRepoConfigStore(storage), operations = new CommunityProjectionOperations();
  const projector = new CommunityProjector(events, objects, operations);
  await configs.upsert({ repo: input.repoFullName, guardCatId: 'cat', guardThreadId: 'thread', reviewMode: 'maintainer_review', cloudReviewPolicy: 'optional' });
  for (const [i, [kind, payload]] of ([
    ['case.external_review_assigned', { mode: 'maintainer_review', cloudPolicy: 'optional', reviewerCatId: 'cat', reviewerThreadId: 'thread', actionLeaseRef: input.actionLeaseRef }],
    ['case.head_observed', { headSha: head }],
    ['case.ci_observed', { headSha: head, status: 'pass' }],
    ['case.review_ready', { headSha: head }],
  ] as const).entries()) {
    const event = { sourceEventId: 'seed-'+i, subjectKey: subject, kind, payload, classification: 'informational' as const, at: i+1 };
    await events.append(event); await projector.apply(event);
  }
  assert.equal((await objects.get(subject))?.externalReview?.lifecycle, 'rereview_required');
  return { storage, events, objects, configs, projector, operations };
}

test('ready delivered verdict is durably submitted before Host completion; insufficient preserves it for native retry', async () => {
  const f = await fixture(); let calls = 0;
  const service = new ExternalReviewVerdictService({ repoConfigStore: f.configs, eventLog: f.events, objectStore: f.objects, projector: f.projector,
    fetchCurrentHead: async () => head, canonicalizeCompletionPredicate: async () => ({ digest: 'b'.repeat(64) }),
    preflightLease: async () => ({ ok: true, reason: 'active' }), completeActionLease: async () => {
      calls++; const pending = (await f.objects.get(subject))?.externalReview?.pendingVerdict;
      assert.equal(pending?.delivery.kind, 'delivered', 'completion must see a durable intent');
      assert.deepEqual(pending?.actionLeaseRef, input.actionLeaseRef);
      return { outcome: 'insufficient' };
    } });
  const result = await service.record(input);
  assert.equal(result.lifecycle, 'pending_verification');
  assert.equal(result.verification?.reason, 'custody_verification_pending');
  assert.equal(calls, 1);
  assert.equal((await f.objects.get(subject))?.externalReview?.delivery, null);
  assert.equal((await f.events.read(subject)).filter(e => e.kind === 'case.review_verdict_recorded').length, 0);
  await f.projector.rebuild(subject);
  assert.ok((await f.objects.get(subject))?.externalReview?.pendingVerdict, 'intent survives rebuild');
  await service.record(input);
  assert.equal(calls, 2);
  assert.equal((await f.events.read(subject)).filter(e => e.kind === 'case.review_verdict_submitted').length, 1);
});

import { CommunityReviewVerdictRuntime } from './community-review-verdict.js';
import type { PluginActionContext, PluginCustodyHost } from '@clowder-ai/plugin-sdk';
const caller: PluginActionContext = { catId: 'cat', threadId: 'thread', userId: 'owner', invocationId: 'inv', assertCurrent: async () => {} };
const { principal: _principal, ...nativeInput } = input;
async function nativeFixture() {
  const f = await fixture(); const calls: { method: string; value: unknown }[] = [];
  const custody: PluginCustodyHost = {
    canonicalize: async value => { calls.push({ method: 'canonicalize', value }); return { digest: 'b'.repeat(64) }; },
    preflight: async value => { calls.push({ method: 'preflight', value }); return { ok: true, reason: 'active' }; },
    complete: async value => { calls.push({ method: 'complete', value });
      assert.ok((await f.objects.get(subject))?.externalReview?.pendingVerdict);
      return { outcome: 'insufficient', reason: 'publisher_association_unavailable' }; },
  };
  const provider = { observeReviewHead: async () => ({ state: 'open' as const, headSha: head, repo: input.repoFullName, prNumber: 12 }) };
  const runtime = new CommunityReviewVerdictRuntime({ storage: f.storage, custody, projectionOperations: f.operations, provider });
  return { ...f, calls, custody, provider, runtime };
}

test('native adapter requires second context and strips service identity/time from all three custody calls', async t => {
  const f = await nativeFixture(); t.after(() => f.runtime.stop());
  await assert.rejects(f.runtime.record(nativeInput), /native action context/);
  await assert.rejects(f.runtime.record({ ...nativeInput, principal: input.principal }, caller));
  assert.equal(f.calls.length, 0);
  const result = await f.runtime.record(nativeInput, caller);
  assert.equal(result.data.lifecycle, 'pending_verification');
  assert.deepEqual(f.calls.map(c => c.method), ['canonicalize', 'preflight', 'complete']);
  assert.deepEqual(f.calls[1]!.value, { leaseId: 'lease', generation: 1, terminalPredicateDigest: 'b'.repeat(64) });
  assert.deepEqual(f.calls[2]!.value, { leaseId: 'lease', generation: 1, evidenceRefs: ['github:'+input.delivery.githubUrl] });
  assert.ok(f.calls.every(call => !('catId' in (call.value as object)) && !('now' in (call.value as object))));
});

test('restart requires a fresh native caller; pending intent is not background authority', async t => {
  const f = await nativeFixture(); await f.runtime.record(nativeInput, caller); await f.runtime.stop();
  const count = f.calls.length;
  const service = new ExternalReviewVerdictService({ repoConfigStore: f.configs, eventLog: f.events, objectStore: f.objects, projector: f.projector,
    fetchCurrentHead: async () => { throw new Error('background fetch'); },
    canonicalizeCompletionPredicate: async () => { throw new Error('background authority'); },
    preflightLease: async () => { throw new Error('background authority'); }, completeActionLease: async () => { throw new Error('background authority'); } });
  assert.deepEqual(await service.settlePending(subject), { kind: 'waiting', reason: 'native_submission_required' });
  assert.equal(f.calls.length, count);
  const restarted = new CommunityReviewVerdictRuntime({ storage: f.storage, custody: f.custody, projectionOperations: f.operations, provider: f.provider });
  t.after(() => restarted.stop());
  assert.equal((await restarted.record(nativeInput, { ...caller, invocationId: 'new-inv' })).data.lifecycle, 'pending_verification');
  assert.equal((await f.events.read(subject)).filter(e => e.kind === 'case.review_verdict_submitted').length, 1);
});

test('caller invalidation or policy removal during provider IO prevents custody and writes', async t => {
  for (const mode of ['caller', 'policy']) {
    const f = await nativeFixture(); t.after(() => f.runtime.stop()); let valid = true;
    f.provider.observeReviewHead = async () => {
      if (mode === 'caller') valid = false; else await f.configs.deleteByRepo(input.repoFullName);
      return { state: 'open', headSha: head, repo: input.repoFullName, prNumber: 12 };
    };
    await assert.rejects(f.runtime.record(nativeInput, { ...caller, assertCurrent: async () => { if (!valid) throw new Error('expired'); } }));
    assert.equal(f.calls.length, 0);
    assert.equal((await f.events.read(subject)).length, 4);
  }
});

test('native stop aborts and joins pending provider reads without persisting a verdict', async () => {
  const f = await nativeFixture(); let enter!: () => void, finish!: () => void; let aborted = false;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const provider = { observeReviewHead: async (_target: unknown, signal: AbortSignal) => {
    enter(); await new Promise<void>(resolve => { finish = resolve; signal.addEventListener('abort', () => { aborted = true; }, { once: true }); });
    return { state: 'open' as const, headSha: head, repo: input.repoFullName, prNumber: 12 };
  } };
  const runtime = new CommunityReviewVerdictRuntime({ storage: f.storage, custody: f.custody, projectionOperations: f.operations, provider });
  const run = runtime.record(nativeInput, caller); const rejected = assert.rejects(run);
  await entered; let stopped = false; const stop = runtime.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(aborted, true); assert.equal(stopped, false);
  finish(); await rejected; await stop; await f.runtime.stop();
  assert.equal(f.calls.length, 0); assert.equal((await f.events.read(subject)).length, 4);
});

test('wrong reviewer, lease generation and body authority are rejected before provider or custody IO', async t => {
  const f = await nativeFixture(); t.after(() => f.runtime.stop());
  f.provider.observeReviewHead = async () => { throw new Error('must not call provider'); };
  await assert.rejects(f.runtime.record(nativeInput, { ...caller, catId: 'other' }), /private reviewer/);
  await assert.rejects(f.runtime.record({ ...nativeInput, actionLeaseRef: { leaseId: 'lease', generation: 2 } }, caller), /lease/);
  for (const field of ['catId','threadId','userId','now','verified','invocationId']) await assert.rejects(f.runtime.record({ ...nativeInput, [field]: 'forged' }, caller));
  assert.equal(f.calls.length, 0);
});

test('concurrent contradictory submissions cannot replace the durable candidate', async t => {
  const f = await nativeFixture(); t.after(() => f.runtime.stop());
  const results = await Promise.allSettled([f.runtime.record(nativeInput, caller), f.runtime.record({ ...nativeInput, verdict: 'changes_requested' }, caller)]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.equal((await f.objects.get(subject))?.externalReview?.pendingVerdict?.verdict, 'approved');
  assert.equal(f.calls.filter(c => c.method === 'complete').length, 1);
});

test('committed Host completion records once; success replay still calls authorized Host preflight and complete', async t => {
  const f = await nativeFixture(); t.after(() => f.runtime.stop()); let completed = false;
  f.custody.preflight = async value => { f.calls.push({ method: 'preflight', value }); return { ok: true, reason: completed ? 'verified_success' : 'active' }; };
  f.custody.complete = async value => { f.calls.push({ method: 'complete', value }); completed = true; return { outcome: 'committed', leaseId: value.leaseId, generation: value.generation }; };
  assert.equal((await f.runtime.record(nativeInput, caller)).data.lifecycle, 'delivered');
  assert.equal((await f.runtime.record(nativeInput, caller)).data.lifecycle, 'delivered');
  assert.equal(f.calls.filter(c => c.method === 'complete').length, 2);
  assert.equal((await f.events.read(subject)).filter(e => e.kind === 'case.review_verdict_recorded').length, 1);
});

test('journal or projection write failure never completes; retry rebuilds the committed intent', async t => {
  for (const prefix of ['community.event.', 'community.object.']) {
    const f = await nativeFixture(); t.after(() => f.runtime.stop());
    const set = f.storage.set, cas = f.storage.compareAndSet; let fail = true;
    f.storage.set = async (key, value) => { if (fail && key.startsWith(prefix)) throw new Error('write unavailable'); return set(key,value); };
    f.storage.compareAndSet = async (key, revision, value) => { if (fail && key.startsWith(prefix)) throw new Error('write unavailable'); return cas(key,revision,value); };
    await assert.rejects(f.runtime.record(nativeInput, caller), /write unavailable/);
    assert.equal(f.calls.filter(c => c.method === 'complete').length, 0);
    fail = false; assert.equal((await f.runtime.record(nativeInput, caller)).data.lifecycle, 'pending_verification');
    assert.equal((await f.events.read(subject)).filter(e => e.kind === 'case.review_verdict_submitted').length, 1);
  }
});

test('assignment or terminal change during preflight cannot persist a current verdict or complete', async t => {
  for (const terminal of [false,true]) {
    const f=await nativeFixture(); t.after(()=>f.runtime.stop());
    f.custody.preflight=async()=>{
      const event={sourceEventId:'changed',subjectKey:subject,kind:terminal?'pr.closed' as const:'case.external_review_assigned' as const,
        payload:terminal?{}:{mode:'maintainer_review',cloudPolicy:'optional',reviewerCatId:'other',reviewerThreadId:'thread',actionLeaseRef:input.actionLeaseRef},classification:terminal?'state-changing' as const:'informational' as const,at:10};
      await f.events.append(event);await f.projector.apply(event);
      const changed=(await f.objects.get(subject))!.externalReview!;
      assert.equal(terminal ? changed.lifecycle : changed.reviewerCatId, terminal ? 'terminal' : 'other', 'fixture applies competing change');
      return {ok:true,reason:'active'};
    };
    await assert.rejects(f.runtime.record(nativeInput,caller),/not represented/);
    assert.equal(f.calls.filter(c=>c.method==='complete').length,0);
    await f.projector.rebuild(subject);
    assert.equal((await f.objects.get(subject))?.externalReview?.pendingVerdict,null);
  }
});


test('completed lease only accepts the original verdict, summary, nudge and delivery on native replay', async t => {
  const f = await nativeFixture(); t.after(() => f.runtime.stop()); let completed = false, completions = 0;
  f.custody.preflight = async () => ({ ok: true, reason: completed ? 'verified_success' : 'active' });
  f.custody.complete = async value => { completed = true; completions++; return { outcome: 'committed', leaseId: value.leaseId, generation: value.generation }; };
  const original = await f.runtime.record(nativeInput, caller);
  const before = (await f.objects.get(subject))!.externalReview;
  for (const delta of [
    { verdict: 'changes_requested' }, { summary: 'Replaced summary' }, { userNudgeRequired: true },
    { delivery: { kind: 'delivered', githubUrl: 'https://github.com/example/project/pull/12#pullrequestreview-81' } },
  ]) {
    await assert.rejects(f.runtime.record({ ...nativeInput, ...delta }, caller), { code: 'verdict_conflict' });
    assert.equal(completions, 1, 'conflicting replay never calls success-only Host completion');
    assert.deepEqual((await f.objects.get(subject))!.externalReview, before);
  }
  assert.deepEqual(await f.runtime.record(nativeInput, { ...caller, invocationId: 'retry' }), original);
  assert.equal(completions, 2, 'exact replay still reauthorizes with Host');
  assert.equal((await f.events.read(subject)).filter(e => e.kind === 'case.review_verdict_recorded').length, 1);
});

test('committed verdict remains immutable after event append but projection failure and rebuild', async t => {
  const f = await nativeFixture(); t.after(() => f.runtime.stop()); let completed = false, completions = 0;
  f.custody.preflight = async () => ({ ok: true, reason: completed ? 'verified_success' : 'active' });
  f.custody.complete = async value => { completed = true; completions++; return { outcome: 'committed', leaseId: value.leaseId, generation: value.generation }; };
  const set = f.storage.set;
  f.storage.set = async (key, value) => {
    if (completed && key.startsWith('community.object.')) throw new Error('projection unavailable after completion');
    return set(key, value);
  };
  await assert.rejects(f.runtime.record(nativeInput, caller), /projection unavailable/);
  f.storage.set = set;
  await assert.rejects(f.runtime.record({ ...nativeInput, summary: 'different' }, caller), { code: 'verdict_conflict' });
  await f.projector.rebuild(subject);
  await assert.rejects(f.runtime.record({ ...nativeInput, delivery: { ...nativeInput.delivery, githubUrl: 'https://github.com/example/project/pull/12#pullrequestreview-81' } }, caller), { code: 'verdict_conflict' });
  assert.equal((await f.runtime.record(nativeInput, caller)).data.delivery.kind, 'delivered');
  assert.equal(completions, 2);
  assert.equal((await f.events.read(subject)).filter(e => e.kind === 'case.review_verdict_recorded').length, 1);
});

test('projector and replay retain the first delivered verdict against a later contradictory recorded event', async t => {
  const f = await nativeFixture(); t.after(() => f.runtime.stop());
  f.custody.complete = async value => ({ outcome: 'committed', leaseId: value.leaseId, generation: value.generation });
  await f.runtime.record(nativeInput, caller);
  const first = (await f.events.read(subject)).find(e => e.kind === 'case.review_verdict_recorded')!;
  const later = { ...first, sourceEventId: 'contradictory-recorded', at: first.at + 1,
    payload: { ...first.payload, verdict: 'changes_requested', delivery: { ...first.payload.delivery as object, githubUrl: 'https://github.com/example/project/pull/12#pullrequestreview-81' } } };
  await f.events.append(later); await f.projector.apply(later);
  assert.equal(((await f.objects.get(subject))!.externalReview!.delivery as { githubUrl: string }).githubUrl, input.delivery.githubUrl);
  await f.projector.rebuild(subject);
  assert.equal(((await f.objects.get(subject))!.externalReview!.delivery as { githubUrl: string }).githubUrl, input.delivery.githubUrl);
});


test('legacy delivered projection without a submission marker fails closed; a new HEAD generation clears the marker', async t => {
  const f = await nativeFixture(); t.after(() => f.runtime.stop()); let completions = 0;
  f.custody.complete = async value => { completions++; return { outcome: 'committed', leaseId: value.leaseId, generation: value.generation }; };
  await f.runtime.record(nativeInput, caller);
  const projection = (await f.objects.get(subject))!;
  await f.objects.save({ ...projection, externalReview: { ...projection.externalReview!, deliveredVerdictFingerprint: undefined } });
  await assert.rejects(f.runtime.record(nativeInput, caller), { code: 'verdict_conflict' });
  assert.equal(completions, 1);
  await f.projector.rebuild(subject);
  const event = { sourceEventId: 'next-generation', subjectKey: subject, kind: 'case.head_observed' as const,
    classification: 'informational' as const, payload: { headSha: 'c'.repeat(40) }, at: Date.now() };
  await f.events.append(event); await f.projector.apply(event);
  const next = (await f.objects.get(subject))!.externalReview!;
  assert.equal(next.headGeneration, 2);
  assert.equal(next.delivery, null);
  assert.equal(next.deliveredVerdictFingerprint, null);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryStorage } from '../test/memory-storage.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { SdkCommunityObjectStore } from './business/domains/community/CommunityObjectStore.js';
import { SdkCommunityRepoConfigStore } from './business/domains/community/CommunityRepoConfigStore.js';
import { CommunityProjector, CommunityProjectionOperations } from './business/domains/community/community-projector.js';
import {CommunityReviewVerdictRuntime} from './community-review-verdict.js';
import type {PluginActionContext} from '@clowder-ai/plugin-sdk';

const head = 'a'.repeat(40), subject = 'pr:example/project#12';
const input = { repoFullName: 'example/project', prNumber: 12, reviewedHeadSha: head, verdict: 'approved' as const,
  summary: 'Reviewed', delivery: { kind: 'delivered' as const, githubUrl: 'https://github.com/example/project/pull/12#pullrequestreview-80' },
  principal: { catId: 'cat', threadId: 'thread' } };
async function fixture() {
  const storage = memoryStorage(), events = new SdkCommunityEventLog(storage), objects = new SdkCommunityObjectStore(storage);
  const configs = new SdkCommunityRepoConfigStore(storage), operations = new CommunityProjectionOperations();
  const projector = new CommunityProjector(events, objects, operations);
  await configs.upsert({ repo: input.repoFullName, guardCatId: 'cat', guardThreadId: 'thread', reviewMode: 'maintainer_review', cloudReviewPolicy: 'optional' });
  for (const [i, [kind, payload]] of ([
    ['case.external_review_assigned', { mode: 'maintainer_review', cloudPolicy: 'optional', reviewerCatId: 'cat', reviewerThreadId: 'thread' }],
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


function caller():PluginActionContext {return {catId:'cat',threadId:'thread',userId:'owner',invocationId:'invocation',async assertCurrent(){}} as PluginActionContext;}
function payload() {const {principal,...value}=input;return value;}
function runtime(f:Awaited<ReturnType<typeof fixture>>,observe=async()=>({state:'open' as const,headSha:head})) {
 return new CommunityReviewVerdictRuntime({storage:f.storage,projectionOperations:f.operations,provider:{observeReviewHead:async()=>({...await observe(),repo:input.repoFullName,prNumber:input.prNumber})}});
}
test('native review stores GitHub facts without a Host completion call',async t=>{
 const f=await fixture(), active=runtime(f);t.after(()=>active.stop());
 const result=await active.record(payload(),caller());assert.equal(result.data.lifecycle,'delivered');
 assert.equal((await f.objects.get(subject))?.externalReview?.delivery?.kind,'delivered');
 const records=await f.events.read(subject);
 assert.equal(records.filter(event=>event.kind==='case.review_verdict_recorded').length,1);
 assert.equal(Object.hasOwn(records.at(-1)!.payload,'actionLeaseRef'),false);
});
test('review replay remains idempotent after module restart',async()=>{
 const f=await fixture(), first=runtime(f);await first.record(payload(),caller());await first.stop();
 const next=runtime(f);try {await next.record(payload(),caller());assert.equal((await f.events.read(subject)).filter(event=>event.kind==='case.review_verdict_recorded').length,1);}finally{await next.stop();}
});
test('caller identity comes from the authenticated second context; Host leases are not inputs',async t=>{
 const f=await fixture(), active=runtime(f);t.after(()=>active.stop());
 await assert.rejects(active.record(payload()),/context/);
 await assert.rejects(active.record(payload(),{...caller(),catId:'other'}),/reviewer/);
 await assert.rejects(active.record({...payload(),actionLeaseRef:{leaseId:'lease',generation:1}},caller()));
 await assert.rejects(active.record({...payload(),catId:'cat'},caller()));
});
test('expired invocation or changed repository policy cannot record a late provider result',async t=>{
 const f=await fixture();let reads=0;
 const active=runtime(f,async()=>{reads++;await f.configs.deleteByRepo(input.repoFullName);return {state:'open',headSha:head};});t.after(()=>active.stop());
 await assert.rejects(active.record(payload(),{...caller(),async assertCurrent(){throw new Error('expired');}}),/expired/);assert.equal(reads,0);
 await assert.rejects(active.record(payload(),caller()),/policy changed/);assert.equal(reads,1);
 assert.equal((await f.events.read(subject)).filter(event=>event.kind==='case.review_verdict_recorded').length,0);
});
test('provider HEAD mismatch refuses a stale review fact',async t=>{
 const f=await fixture(), active=runtime(f,async()=>({state:'open',headSha:'b'.repeat(40)}));t.after(()=>active.stop());
 await assert.rejects(active.record(payload(),caller()),/HEAD/);
});

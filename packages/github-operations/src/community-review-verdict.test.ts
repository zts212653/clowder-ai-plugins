import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryStorage } from '../test/memory-storage.js';
import { SdkCommunityEventLog } from './business/domains/community/CommunityEventLog.js';
import { SdkCommunityObjectStore } from './business/domains/community/CommunityObjectStore.js';
import { SdkCommunityRepoConfigStore } from './business/domains/community/CommunityRepoConfigStore.js';
import { CommunityProjector, CommunityProjectionOperations } from './business/domains/community/community-projector.js';
import {CommunityReviewVerdictRuntime} from './community-review-verdict.js';
import type {PluginActionContext} from '@clowder-ai/plugin-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRemoteTrackingMcpServer } from './tracking-mcp-server.js';
import { readReviewVerdictFailure } from './review-verdict-failure.js';

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
 return new CommunityReviewVerdictRuntime({storage:f.storage,secrets:{get:async()=>undefined},projectionOperations:f.operations,provider:{observeReviewHead:async()=>({...await observe(),repo:input.repoFullName,prNumber:input.prNumber})}});
}
function recorded(result: Awaited<ReturnType<CommunityReviewVerdictRuntime['record']>>) {
 assert.ok('data' in result); return result.data;
}
function failureCode(result: Awaited<ReturnType<CommunityReviewVerdictRuntime['record']>>) {
 assert.ok('body' in result); return result.body.error.code;
}
test('native review stores GitHub facts without a Host completion call',async t=>{
 const f=await fixture(), active=runtime(f);t.after(()=>active.stop());
 const result=await active.record(payload(),caller());assert.equal(recorded(result).lifecycle,'delivered');
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
 assert.equal(failureCode(await active.record(payload())), 'native_context_required');
 assert.equal(failureCode(await active.record(payload(),{...caller(),catId:'other'})), 'wrong_principal');
 assert.equal(failureCode(await active.record({...payload(),actionLeaseRef:{leaseId:'lease',generation:1}},caller())), 'invalid_input');
 assert.equal(failureCode(await active.record({...payload(),catId:'cat'},caller())), 'invalid_input');
});
test('expired invocation or changed repository policy cannot record a late provider result',async t=>{
 const f=await fixture();let reads=0;
 const active=runtime(f,async()=>{reads++;await f.configs.deleteByRepo(input.repoFullName);return {state:'open',headSha:head};});t.after(()=>active.stop());
 assert.equal(failureCode(await active.record(payload(),{...caller(),async assertCurrent(){throw new Error('expired');}})), 'registration_unavailable');assert.equal(reads,0);
 assert.equal(failureCode(await active.record(payload(),caller())), 'policy_changed');assert.equal(reads,1);
 assert.equal((await f.events.read(subject)).filter(event=>event.kind==='case.review_verdict_recorded').length,0);
});
test('provider HEAD mismatch refuses a stale review fact',async t=>{
 const f=await fixture(), active=runtime(f,async()=>({state:'open',headSha:'b'.repeat(40)}));t.after(()=>active.stop());
 assert.equal(failureCode(await active.record(payload(),caller())), 'stale_head');
});

async function callThroughMcp(active: CommunityReviewVerdictRuntime) {
 const server = createRemoteTrackingMcpServer({ invoke: async (_method, value) => active.record(value, caller()) });
 const client = new Client({ name: 'review-receipt-consumer', version: '1' });
 const [a, b] = InMemoryTransport.createLinkedPair();
 await server.connect(a); await client.connect(b);
 try {
  return await client.callTool({ name: 'github_record_external_review_verdict', arguments: payload() });
 } finally { await client.close(); await server.close(); }
}

test('missing reviewer reaches the MCP consumer as a recoverable refusal, without recording a verdict', async t => {
 const f = await fixture(), active = runtime(f); t.after(() => active.stop());
 await f.objects.delete(subject);
 const result = await callThroughMcp(active);
 assert.equal(result.isError, true);
 assert.match(JSON.stringify(result.content), /review_unassigned/);
 assert.match(JSON.stringify(result.content), /recovery/);
 assert.equal((await f.events.read(subject)).filter(event => event.kind === 'case.review_verdict_recorded').length, 0);
});

test('a lagging projection is distinguished from stale GitHub HEAD at the real MCP consumer', async t => {
 const f = await fixture(), active = runtime(f); t.after(() => active.stop());
 const projected = (await f.objects.get(subject))!;
 await f.objects.save({ ...projected, externalReview: { ...projected.externalReview!, currentHeadSha: 'b'.repeat(40) } });
 const result = await callThroughMcp(active);
 assert.equal(result.isError, true);
 assert.match(JSON.stringify(result.content), /projection_unavailable/);
 assert.match(JSON.stringify(result.content), /refresh_projection/);
 assert.match(JSON.stringify(result.content), /not_recorded/);
 assert.equal((await f.events.read(subject)).filter(event => event.kind === 'case.review_verdict_recorded').length, 0);
});

test('post-merge registration refuses terminal subjects explicitly and preserves earlier evidence', async t => {
 const f = await fixture(), active = runtime(f); t.after(() => active.stop());
 const projected = (await f.objects.get(subject))!;
 await f.objects.save({ ...projected, externalReview: { ...projected.externalReview!, lifecycle: 'terminal' } });
 const before = await f.events.read(subject);
 const result = await callThroughMcp(active);
 assert.equal(result.isError, true);
 assert.match(JSON.stringify(result.content), /subject_terminal/);
 assert.match(JSON.stringify(result.content), /retain_delivery_evidence/);
 assert.deepEqual(await f.events.read(subject), before);
});

test('provider failure has a redacted durable diagnostic and no false delivery', async t => {
 const f = await fixture();
 const secret = 'isolated-review-credential';
 const active = new CommunityReviewVerdictRuntime({
  storage: f.storage, secrets: { get: async () => secret }, projectionOperations: f.operations,
  provider: { observeReviewHead: async () => { throw new Error(`provider failed ${secret}`); } },
 });
 t.after(() => active.stop());
 const result = await callThroughMcp(active);
 assert.equal(result.isError, true);
 assert.match(JSON.stringify(result.content), /provider_read_failed/);
 assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
 const diagnostic = await readReviewVerdictFailure(f.storage, subject);
 assert.equal(diagnostic?.failure.body.outcome, 'not_recorded');
 assert.equal(diagnostic?.failure.body.diagnosticPersisted, true);
 assert.match(diagnostic!.error.message, /provider failed \[redacted\]/);
 assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(secret));
 assert.equal((await f.objects.get(subject))?.externalReview?.delivery, null);
});

test('a partial verdict write is unknown until the unchanged submission replays exactly once', async t => {
 const f = await fixture(), originalSet = f.storage.set;
 let refuseProjection = true;
 f.storage.set = async (key, value) => {
  if (refuseProjection && key.startsWith('community.object.')) {
   refuseProjection = false;
   throw new Error('isolated projection write failure');
  }
  return originalSet(key, value);
 };
 const active = runtime(f); t.after(() => active.stop());
 const first = await active.record(payload(), caller());
 assert.equal(failureCode(first), 'registration_unavailable');
 assert.ok('body' in first);
 assert.equal(first.body.outcome, 'unknown');
 assert.equal(recorded(await active.record(payload(), { ...caller(), invocationId: 'fresh-invocation' })).lifecycle, 'delivered');
 assert.equal((await f.events.read(subject)).filter(event => event.kind === 'case.review_verdict_recorded').length, 1);
 assert.equal((await f.objects.get(subject))?.externalReview?.delivery?.kind, 'delivered');
});

test('failure of diagnostic storage is explicit and does not mask the business refusal', async t => {
 const f = await fixture(), originalSet = f.storage.set;
 await f.objects.delete(subject);
 f.storage.set = async (key, value) => {
  if (key.startsWith('github.review-verdict-failure.')) throw new Error('diagnostic disk unavailable');
  return originalSet(key, value);
 };
 const active = runtime(f); t.after(() => active.stop());
 const result = await active.record(payload(), caller());
 assert.equal(failureCode(result), 'review_unassigned');
 assert.ok('body' in result);
 assert.equal(result.body.diagnosticPersisted, false);
});

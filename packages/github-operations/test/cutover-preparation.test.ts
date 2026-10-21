import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginStorageHost } from '@clowder-ai/plugin-sdk';
import type { TaskItem } from '../src/business/model/index.js';
import { GitHubWaitStorage } from '../src/typed-wait-storage.js';
import { SdkCommunityRepoConfigStore } from '../src/business/domains/community/CommunityRepoConfigStore.js';
import { communityProgressKey } from '../src/legacy-repository-progress.js';
import { TypedWaitRuntime } from '../src/typed-wait-runtime.js';
import type { FeatureContext, PluginTaskReadItem, PluginTaskUpdateInput } from '@clowder-ai/plugin-sdk';
import { families, digest, bytes, prepareCutover, IsolatedStorage, stageRehearsal,
  abortRehearsal, materializeRehearsal, type FrozenSnapshot } from './cutover-preparation.js';

function source(): FrozenSnapshot {
  const task: TaskItem = { id: 'legacy', kind: 'pr_tracking', subjectKey: 'pr:owner/repo#42',
    threadId: 'original-thread', ownerCatId: 'original-cat', createdBy: 'historical-cat', userId: 'owner',
    status: 'doing', title: 'Private fixture title', why: 'Private fixture continuation', createdAt: 1, updatedAt: 2,
    automationState: {
      review: { lastInlineCommentCursor: 17, lastConversationCommentCursor: 23 },
      await: { v: 1, generation: 27, subjectRef: 'pr:owner/repo#42',
        ownerFence: { kind: 'containing_task', generation: 27 }, baseline: { capturedAt: 1, headSha: 'old' },
        continuation: { when: [{ kind: 'pr_head_changed' }], then: 'Original continuation' }, createdAt: 1 },
      waitOutcome: { v: 1, outcomeId: 'wait:pr:owner/repo#42:g26:matched', generation: 26,
        ownerFence: { kind: 'containing_task', generation: 26 }, subjectRef: 'pr:owner/repo#42',
        reason: 'matched', at: 1, delivery: 'delivered' },
    } };
  return { id: 'frozen-fixture', coverage: Object.fromEntries(families.map(f=>[f,'complete'])) as FrozenSnapshot['coverage'],
    oldWriter: 'absent', targetWriter: 'absent', unresolvedReceipts: 0, tasks: [task], repositories: [{
      config: { repo: 'owner/repo', guardThreadId: 'guard-thread', guardCatId: 'guard-cat',
        reviewMode: 'observe_only', cloudReviewPolicy: 'optional', createdAt: 1, updatedAt: 2 },
      progress: { 'f141:baseline:owner/repo': '1', 'f141:notified:owner/repo#pr-42': '1',
        'community:repo-comment:cursor:owner/repo': '2026-10-20T01:22:24.000Z' },
    }] };
}
const routable=new Set(['original-cat','guard-cat']);
const prepare = (s: FrozenSnapshot) => prepareCutover(s, digest(s), structuredClone(s.tasks),routable);

test('copy into real private readers preserves complete wait, original identities, policy and progress', async () => {
  const s = source(), before = bytes(s), plan = await prepare(s), shadow = await materializeRehearsal(plan);
  assert.deepEqual(await new GitHubWaitStorage(shadow).get('legacy'), s.tasks[0]);
  assert.deepEqual(await new SdkCommunityRepoConfigStore(shadow).getByRepo('owner/repo'), s.repositories[0]!.config);
  assert.equal((await shadow.get(communityProgressKey('scan-notified','pr:owner/repo#42')))?.value, true);
  assert.equal((await shadow.get(communityProgressKey('scan-baseline','owner/repo')))?.value, true);
  assert.equal((await shadow.get(communityProgressKey('comment-cursor','owner/repo')))?.value, '2026-10-20T01:22:24.000Z');
  assert.equal(bytes(s), before, 'source is never mutated');
  assert.equal((await new GitHubWaitStorage(shadow).get('legacy'))?.automationState?.waitOutcome?.delivery,'delivered');
});

test('unknown families, receipt gaps, live writers and stale bindings cannot become a plan', async () => {
  for (const family of families) {
    const s=source();s.coverage[family]='unknown';await assert.rejects(prepare(s), /Incomplete/);
  }
  for (const side of ['oldWriter','targetWriter'] as const) {
    const s=source();s[side]='active';await assert.rejects(prepare(s), /paused-writer/);
  }
  const s=source();s.unresolvedReceipts=1;await assert.rejects(prepare(s), /receipt namespace/);
  const stale=source(), bindings=stale.tasks.map(t=>({...t,ownerCatId:'replacement'}));
  await assert.rejects(prepareCutover(stale,digest(stale),bindings,routable),/ownership\/version/);
  await assert.rejects(prepareCutover(stale,'0'.repeat(64),stale.tasks,routable),/digest mismatch/);
});

test('pending outcome is not automatically resent across Host and plugin receipt namespaces', async () => {
  const s=source();s.tasks=s.tasks.map(t=>({...t,automationState:{...t.automationState,
    waitOutcome:{...t.automationState!.waitOutcome!,delivery:'pending'}}}));
  await assert.rejects(prepare(s),/verified receipt bridge/);
});

test('an invalid later repository rejects the entire plan before any real target exists', async () => {
  const s=source();s.repositories[0]!.progress['foreign:token']='secret-fixture';
  await assert.rejects(prepare(s), /unsupported repository progress/);
});

test('staging is inert; interrupted prefix resumes identically without collector-visible tasks', async () => {
  const plan=await prepare(source()), storage=new IsolatedStorage();let inserts=0;
  const interrupted: PluginStorageHost={get:k=>storage.get(k),list:()=>storage.list(),set:(k,v)=>storage.set(k,v),
    delete:(k,r)=>storage.delete(k,r),compareAndSet:async(k,r,v)=>{
      if(++inserts===3) throw new Error('simulated interruption');return storage.compareAndSet(k,r,v);
    }};
  await assert.rejects(stageRehearsal(plan,interrupted,new AbortController().signal),/simulated interruption/);
  assert.deepEqual(await new GitHubWaitStorage(storage).listByKind('pr_tracking'),[]);
  assert.deepEqual(await new SdkCommunityRepoConfigStore(storage).listAll(),[]);
  const result=await stageRehearsal(plan,storage,new AbortController().signal), snapshot=bytes(await storage.list());
  assert.equal(result.pollingStarted,false);
  await stageRehearsal(plan,storage,new AbortController().signal);
  const replay=await storage.list();
  // Journal fence may advance; all staged payloads must remain identical.
  const payloads=(rows:Record<string,{value:unknown}>)=>Object.fromEntries(Object.entries(rows).map(([k,v])=>[k,v.value]));
  assert.equal(bytes(payloads(replay)),bytes(payloads(JSON.parse(snapshot))));
});

test('active target state, staged conflicts and altered plans are refused before additional writes',async()=>{
  const plan=await prepare(source()), storage=new IsolatedStorage();
  await storage.set(Object.keys(plan.records)[0]!,{existing:'current-plugin'});
  const before=bytes(await storage.list());
  await assert.rejects(stageRehearsal(plan,storage,new AbortController().signal),/second writer/);
  assert.equal(bytes(await storage.list()),before);
  const changed=structuredClone(plan);changed.records={'arbitrary-key':true};
  await assert.rejects(materializeRehearsal(changed),/plan changed/);
  const staged=new IsolatedStorage();await stageRehearsal(plan,staged,new AbortController().signal);
  const row=Object.entries(await staged.list()).find(([,v])=>!!v.value && typeof v.value==='object' && 'target' in v.value)!;
  await staged.set(row[0],{target:'conflict',value:'different'});const conflicted=bytes(await staged.list());
  await assert.rejects(stageRehearsal(plan,staged,new AbortController().signal),/Staged row conflict/);
  assert.equal(bytes(await staged.list()),conflicted);
});

test('abort retains inert evidence and fences future staging without deleting source or active state',async()=>{
  const plan=await prepare(source()), storage=new IsolatedStorage();
  await stageRehearsal(plan,storage,new AbortController().signal);await abortRehearsal(plan,storage);
  const before=bytes(await storage.list());
  await assert.rejects(stageRehearsal(plan,storage,new AbortController().signal),/aborted/);
  assert.equal(bytes(await storage.list()),before);
  assert.equal(await new GitHubWaitStorage(storage).get('legacy'),null);
});

test('abort during the final staged row cannot be overwritten by completion',async()=>{
  const plan=await prepare(source()), storage=new IsolatedStorage();let count=0;
  const during:PluginStorageHost={get:k=>storage.get(k),list:()=>storage.list(),set:(k,v)=>storage.set(k,v),
    delete:(k,r)=>storage.delete(k,r),compareAndSet:async(k,r,v)=>{
      const result=await storage.compareAndSet(k,r,v);
      if(++count===Object.keys(plan.records).length+1) await abortRehearsal(plan,storage);
      return result;
    }};
  await assert.rejects(stageRehearsal(plan,during,new AbortController().signal),/aborted/);
});

test('real poller requires a Host projection, then continues old baseline and delivers one new fact to old owner',async()=>{
  const s=source(), plan=await prepare(s), storage=await materializeRehearsal(plan);
  let host:PluginTaskReadItem={...structuredClone(s.tasks[0]!),userId:'owner'};let reads=0;
  const sent:Array<{threadId:string;draft:unknown}>=[];
  const context={storage,config:{get:async()=>undefined},log:()=>{},tasks:{
    get:async()=>structuredClone(host),
    update:async(_id:string,patch:PluginTaskUpdateInput,conditions?:{expectedThreadId?:string})=>{
      if(!patch.wait || conditions?.expectedThreadId!==host.threadId
        || patch.wait.expectedGeneration!==(host.pluginWait?.generation??null))return null;
      const w=patch.wait;host={...host,pluginWait:{pluginInstanceId:'isolated-instance',generation:w.generation,
        ...(w.active?{await:{generation:w.generation,...w.active}}:{}),
        ...(w.outcome?{waitOutcome:w.outcome}:{})}};
      return structuredClone(host);
    },
  },messaging:{send:async(threadId:string,draft:unknown)=>{
    sent.push({threadId,draft});return {threadId,messageId:'isolated-message'};
  }}} as unknown as FeatureContext;
  const runtime=new TypedWaitRuntime({context,coverage:async()=>({covered:true}),now:()=>1000,
    provider:{read:async()=>{reads++;return {state:'open',headSha:'new',ci:'pass',comments:[],reviews:[],commentsComplete:true};}}});
  try {
    await runtime.poll('pr');assert.equal(reads,0);assert.equal(sent.length,0);
    // Simulated Host acknowledgement, not an action this prototype can perform
    // in production. The original generation remains 27 rather than a new 1.
    host={...host,pluginWait:{pluginInstanceId:'isolated-instance',generation:27,await:{generation:27}}};
    await runtime.poll('pr');await runtime.poll('pr');
    assert.equal(sent.length,1);assert.equal(sent[0]!.threadId,'original-thread');
    assert.deepEqual((sent[0]!.draft as {wake:unknown}).wake,{catId:'original-cat'});
    assert.equal((await runtime.store.get('legacy'))?.automationState?.waitOutcome?.generation,27);
  } finally {await runtime.stop();}
});

test('legacy single-cursor issue is refused rather than being assigned a fresh generation',async()=>{
  const s=source();s.tasks=s.tasks.map(t=>({...t,kind:'issue_tracking',subjectKey:'issue:owner/repo#42',
    automationState:{issue:{lastCommentCursor:23,lastDeliveredCursor:23}}}));
  await assert.rejects(prepare(s),/original fenced wait\/baseline/);
});

test('a dead current recipient is refused while an unavailable historical author remains preserved',async()=>{
  const s=source();await assert.rejects(prepareCutover(s,digest(s),s.tasks,new Set(['guard-cat'])),/not routable/);
  const plan=await prepare(s),target=await materializeRehearsal(plan);
  assert.equal((await new GitHubWaitStorage(target).get('legacy'))?.createdBy,'historical-cat');
});

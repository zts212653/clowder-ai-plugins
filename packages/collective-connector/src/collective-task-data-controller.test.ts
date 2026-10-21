import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import type {FeatureContext,PluginOwnerOperationContext,PluginTaskReadItem} from '@clowder-ai/plugin-sdk';
import {adoptCollectiveTaskDataController,listCollectiveTaskDataControllerRows,
  revokeCollectiveTaskDataController} from './collective-task-data-controller.js';
import {readWorkFirstReceipt} from './owner-work-first-receipt.js';

const receiptRef = `task-data-controller:${'a'.repeat(64)}`;
const revokeRef = `task-data-controller:${'b'.repeat(64)}`;
const reboundRef = `task-data-controller:${'d'.repeat(64)}`;
const identity={serviceInstanceId:'svc_12345678',collectiveId:'col_12345678',connectionId:'con_12345678',
  eventId:'evt_12345678',location:{channelId:'general'},catId:'cat',participationRevision:1,
  actor:{kind:'human' as const,humanId:'human_12345678',displayName:'Human'}};
const source = {id:'source-message',threadId:'public',userId:'owner',catId:null,content:'Original Work',mentions:[],
  timestamp:1,sourceRevision:'message-revision',source:{connector:'collective',label:'Collective',icon:'collective',
    meta:{participation:identity}}};
function originalReceipt() {return {v:1 as const,ownerUserId:'owner',source:{id:source.id,revision:source.sourceRevision,
  threadId:source.threadId,bodyDigest:createHash('sha256').update(source.content).digest('hex'),identity},work:{workId:'work_12345678',
    assignmentEventId:'evt_12345678',resultRevision:1,executionRevision:1,intendedOutcomeDigest:'b'.repeat(64)},
  basis:{kind:'standing_grant' as const,producer:'standing_work' as const,grantRef:'standing',grantRevision:1,
    scope:{requestingHumanIds:['human_12345678'],channelIds:['general'],expiresAt:null}}};}
function task():PluginTaskReadItem {return {id:'legacy-task',userId:'owner',kind:'work',threadId:'private',
  subjectKey:'entrusted:legacy',ownerCatId:'cat',title:'Original Work',why:'Deliver it',status:'todo',createdBy:'user',
  createdAt:1,updatedAt:1,entrustedWork:{revision:3,closure:{state:'open'},artifactRefs:['/uploads/original.md'],
    admission:{sourceRefs:[`message:${source.id}`],authorityRef:'message:original-admission'}}};}
function harness(options:{activeBeforeReceipt?:boolean;foreign?:boolean;previousInstance?:boolean;
  stale?:boolean;rebindAfterCrash?:boolean;copiedLocator?:boolean}={}) {
  let currentTask=task(),revision=1,binds=0,revokes=0;
  const records=new Map<string,{revision:number;value:unknown}>();
  const storage={async get(key:string){return structuredClone(records.get(key));},async list(){return{};},
    async set(){throw new Error('unused');},async delete(){throw new Error('unused');},
    async compareAndSet(key:string,expected:number|null,value:unknown){if((records.get(key)?.revision??null)!==expected)return{applied:false};
      records.set(key,{revision:++revision,value:structuredClone(value)});return{applied:true,revision};}};
  const original = originalReceipt();
  const oldLocator={taskRef:options.copiedLocator?'task:work:another-task':'task:work:legacy-task',
    taskRevision:4,threadId:'private',admissionRef:`message:${source.id}`,
    executionRef:`message:${source.id}`,refScope:'task-data-controller:legacy-task:1',dataControllerReceiptRef:receiptRef};
  records.set('collective-owner-admission:'+
    createHash('sha256').update(JSON.stringify(['owner',source.id,'cat'])).digest('hex'),
    {revision,value:options.stale||options.rebindAfterCrash?{...original,binding:oldLocator}:original});
  const active=(foreign=false,bindingRevision=1,currentForCaller=!foreign&&!options.previousInstance,ref=receiptRef)=>({bindingRevision,state:'active' as const,currentForCaller,binding:{userId:'owner',catId:'cat',threadId:'private',
    subjectKey:'entrusted:legacy',firstSourceRef:`message:${source.id}`,admissionAuthorityRef:'message:original-admission',
    pluginId:foreign?'foreign.plugin':'official.collective-connector',pluginInstanceId:foreign?'foreign':
      options.previousInstance&&!currentForCaller?'previous-instance':'installed',
    moduleRef:foreign?'plugin:foreign.plugin':'plugin:official.collective-connector',
    lifecycleRevision:currentForCaller?8:7,grantRevision:currentForCaller?3:2,ownerOperationReceiptRef:ref}});
  if(options.activeBeforeReceipt) currentTask={...currentTask,entrustedWork:{...currentTask.entrustedWork!,revision:4,
    dataController:active(options.foreign,1,!options.stale&&!options.foreign&&!options.previousInstance)}};
  if(options.rebindAfterCrash)currentTask={...currentTask,entrustedWork:{...currentTask.entrustedWork!,revision:5,
    dataController:active(false,2,true,`task-data-controller:${'c'.repeat(64)}`)}};
  const context=({
    pluginInstanceId:'installed',
    storage,
    messaging:{async get(id:string){return id===source.id?source:null;}},
    tasks:{
      async get(selector:{id?:string}){return selector.id===currentTask.id?structuredClone(currentTask):null;},
      async list(){return[currentTask];},
      async create(){throw new Error('must not create');},
      async update(){throw new Error('unused');},
      async bindDataController(input:Record<string,unknown>){
        binds++;assert.equal('confirmed' in input,false);assert.equal('actor' in input,false);
        assert.equal('pluginInstanceId' in input,false);
        const before=currentTask.entrustedWork!.dataController;
        const partialReplay=before?.state==='active'&&before.currentForCaller===true&&!options.stale;
        const expected=partialReplay?currentTask.entrustedWork!.revision-1:currentTask.entrustedWork!.revision;
        assert.equal(input.expectedTaskRevision,expected);
        const bindingRevision=partialReplay?before.bindingRevision:(before?.bindingRevision??0)+1;
        const nextRef=bindingRevision===1?receiptRef:bindingRevision===2?`task-data-controller:${'c'.repeat(64)}`:reboundRef;
        const nextRevision=partialReplay?currentTask.entrustedWork!.revision:currentTask.entrustedWork!.revision+1;
        currentTask={...currentTask,updatedAt:2,entrustedWork:{...currentTask.entrustedWork!,revision:nextRevision,
          dataController:active(false,bindingRevision,true,nextRef)}};
        return{disposition:partialReplay?'replayed':'bound',receiptRef:nextRef,bindingRevision,task:structuredClone(currentTask)};
      },
      async revokeDataController(input:{expectedControllerReceiptRef:string}){
        revokes++;assert.equal(input.expectedControllerReceiptRef,receiptRef);
        currentTask={...currentTask,updatedAt:3,entrustedWork:{...currentTask.entrustedWork!,revision:5,
          dataController:{...active(),bindingRevision:2,state:'revoked',revocationReceiptRef:revokeRef}}};
        return{disposition:'revoked',receiptRef:revokeRef,bindingRevision:2,task:structuredClone(currentTask)};
      },
    },
  } as unknown as FeatureContext);
  return{context,storage,get task(){return currentTask;},binds:()=>binds,revokes:()=>revokes};
}
const owner:PluginOwnerOperationContext={kind:'owner-operation',userId:'owner',pluginInstanceId:'installed',operationKey:'work',
  actionId:'adopt-task',requestId:'owner-request',confirmed:true,signal:new AbortController().signal,assertCurrent:async()=>{}};
const input={taskId:'legacy-task',sourceMessageId:source.id,catId:'cat'};

test('owner adoption binds the exact legacy Task, retains its locator, replays, then revokes without creating',async()=>{
  const f=harness();
  const adopted=await adoptCollectiveTaskDataController(f.context,owner,input,async()=>{});
  assert.equal(adopted.task.id,'legacy-task');assert.equal(f.binds(),1);
  assert.deepEqual(adopted.task.entrustedWork?.artifactRefs,['/uploads/original.md']);
  const stored=await readWorkFirstReceipt(f.storage,'owner',source.id,'cat');
  assert.equal(stored?.binding?.taskRef,'task:work:legacy-task');assert.equal(stored?.binding?.dataControllerReceiptRef,receiptRef);
  const replay=await adoptCollectiveTaskDataController(f.context,owner,input,async()=>{});
  assert.equal(replay.disposition,'replayed');assert.equal(f.binds(),1);
  const revoked=await revokeCollectiveTaskDataController(f.context,{...owner,actionId:'revoke-task'},input,async()=>{});
  assert.equal(revoked.receiptRef,revokeRef);assert.equal(f.revokes(),1);
  const revokeReplay=await revokeCollectiveTaskDataController(f.context,{...owner,actionId:'revoke-task'},input,async()=>{});
  assert.equal(revokeReplay.disposition,'replayed');assert.equal(revokeReplay.receiptRef,revokeRef);assert.equal(f.revokes(),1);
  const rebound=await adoptCollectiveTaskDataController(f.context,owner,input,async()=>{});
  assert.equal(rebound.receiptRef,reboundRef);assert.equal(rebound.task.entrustedWork?.dataController?.bindingRevision,3);
  assert.equal((await readWorkFirstReceipt(f.storage,'owner',source.id,'cat'))?.binding?.dataControllerReceiptRef,reboundRef);
});

test('a Host-success/package-crash replay fills the same locator, while a foreign active controller stays zero-write',async()=>{
  const recovered=harness({activeBeforeReceipt:true});
  const result=await adoptCollectiveTaskDataController(recovered.context,owner,input,async()=>{});
  assert.equal(result.disposition,'replayed');assert.equal(recovered.binds(),1);
  assert.equal((await readWorkFirstReceipt(recovered.storage,'owner',source.id,'cat'))?.binding?.dataControllerReceiptRef,receiptRef);
  const foreign=harness({activeBeforeReceipt:true,foreign:true});
  await assert.rejects(adoptCollectiveTaskDataController(foreign.context,owner,input,async()=>{}),
    {code:'OWNER_DATA_CONTROLLER_CONFLICT'});
  assert.equal(foreign.binds(),0);
});

test('a stale same-installation controller needs a new confirmed bind and replaces only its current locator receipt',async()=>{
  const f=harness({activeBeforeReceipt:true,stale:true});
  const result=await adoptCollectiveTaskDataController(f.context,owner,input,async()=>{});
  assert.equal(result.disposition,'bound');assert.equal(result.bindingRevision,2);assert.equal(f.binds(),1);
  assert.equal(result.task.entrustedWork?.dataController?.currentForCaller,true);
  assert.equal((await readWorkFirstReceipt(f.storage,'owner',source.id,'cat'))?.binding?.dataControllerReceiptRef,
    `task-data-controller:${'c'.repeat(64)}`);
});

test('a reinstalled current module adopts the retired installation locator only after a new owner confirmation',async()=>{
  const f=harness({activeBeforeReceipt:true,previousInstance:true,stale:true});
  assert.equal((await listCollectiveTaskDataControllerRows(f.context,'owner',async()=>{}))[0]?.actions?.[0]?.action,'adopt-task');
  const result=await adoptCollectiveTaskDataController(f.context,owner,input,async()=>{});
  assert.equal(result.disposition,'bound');assert.equal(result.task.entrustedWork?.dataController?.binding.pluginInstanceId,'installed');
  assert.equal(result.bindingRevision,2);assert.equal(f.binds(),1);
});

test('a Host-success/package-crash during rebind replays the new receipt and advances the old locator once',async()=>{
  const f=harness({rebindAfterCrash:true});
  const result=await adoptCollectiveTaskDataController(f.context,owner,input,async()=>{});
  assert.equal(result.disposition,'replayed');assert.equal(result.bindingRevision,2);assert.equal(f.binds(),1);
  assert.equal((await readWorkFirstReceipt(f.storage,'owner',source.id,'cat'))?.binding?.dataControllerReceiptRef,
    `task-data-controller:${'c'.repeat(64)}`);
});

test('a copied locator cannot authorize adoption or be rewritten onto another Task',async()=>{
  const f=harness({rebindAfterCrash:true,copiedLocator:true});
  const before=structuredClone(await readWorkFirstReceipt(f.storage,'owner',source.id,'cat'));
  await assert.rejects(adoptCollectiveTaskDataController(f.context,owner,input,async()=>{}),
    {code:'OWNER_TASK_LOCATOR_UNAVAILABLE'});
  assert.equal(f.binds(),0);
  assert.deepEqual(await readWorkFirstReceipt(f.storage,'owner',source.id,'cat'),before);
  assert.equal((await listCollectiveTaskDataControllerRows(f.context,'owner',async()=>{}))[0]?.actions,undefined);
});

test('owner inventory keeps adoption and revocation actions discoverable from durable Task truth',async()=>{
  const f=harness();
  const rows=()=>listCollectiveTaskDataControllerRows(f.context,'owner',async()=>{});
  assert.equal((await rows())[0]?.actions?.[0]?.action,'adopt-task');
  await adoptCollectiveTaskDataController(f.context,owner,input,async()=>{});
  assert.equal((await rows())[0]?.actions?.[0]?.action,'revoke-task');
  await revokeCollectiveTaskDataController(f.context,{...owner,actionId:'revoke-task'},input,async()=>{});
  assert.equal((await rows())[0]?.actions?.[0]?.action,'adopt-task');
  const foreign=harness({activeBeforeReceipt:true,foreign:true});
  assert.equal((await listCollectiveTaskDataControllerRows(foreign.context,'owner',async()=>{}))[0]?.actions,undefined);
});

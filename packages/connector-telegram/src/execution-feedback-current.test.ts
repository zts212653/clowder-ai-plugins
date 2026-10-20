import assert from 'node:assert/strict';
import test from 'node:test';
import type {FeatureContext} from '@clowder-ai/plugin-sdk';
import {createConnectorLifecycleAction} from './lifecycle-action.js';
test('one delivery status path preserves started, blocked, resumed and settled Telegram feedback',async()=>{
 const entries=new Map<string,{revision:number;value:unknown}>();
 entries.set('thread-mappings.v1',{revision:1,value:[{key:'chat',threadId:'thread',createdAt:1}]});
 const effects:string[]=[];
 const context={storage:{get:async(key:string)=>entries.get(key),list:async()=>Object.fromEntries(entries),
  set:async(key:string,value:unknown)=>{const revision=(entries.get(key)?.revision??0)+1;entries.set(key,{revision,value});return {revision};},
  delete:async(key:string)=>({deleted:entries.delete(key)})},threads:{get:async()=>({id:'thread'})},log(){}} as unknown as FeatureContext;
 const handle=createConnectorLifecycleAction(context,{sendPlaceholder:async()=>{effects.push('started');return 'placeholder';},
  editPlaceholder:async(_chat,_id,_text,phase)=>{effects.push(phase);return true;},sendRecovery:async()=>{effects.push('recovery');},
  settle:async({recoveryText})=>{assert.equal(recoveryText,undefined,'a resumed execution no longer carries the old blocked hint');effects.push('settled');}});
 const events=[{state:'started',presentation:{actor:{displayName:'Cat',emoji:'🐱'},thread:{shortId:'one'}}},
  {state:'blocked',reason:'temporary provider failure'},{state:'resumed'},{state:'settled',chainDone:true,outcome:'completed'}];
 for(const [index,event]of events.entries()) {
  const deliveryId=`delivery-${index}`;assert.deepEqual(await handle({kind:'execution_status' as const,executionId:'execution',threadId:'thread',deliveryId,...event}),{deliveryId});
 }
 assert.deepEqual(effects,['started','blocked','catching_up','settled']);
 await handle({kind:'execution_status' as const,executionId:'execution',threadId:'thread',deliveryId:'delivery-2',state:'resumed'});
 assert.equal(effects.length,4,'an exact retry does not repeat the platform effect');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {defineDeliveryAction} from './delivery.js';
import {isPluginDeliveryInput} from '@clowder-ai/plugin-contract';
test('one delivery handler acknowledges message and execution updates without claiming execution success',async()=>{
 const seen:string[]=[];const delivery=defineDeliveryAction(input=>{seen.push(input.kind);return {deliveryId:input.deliveryId};});
 const events=[{kind:'execution_status',executionId:'run',threadId:'thread',deliveryId:'started',state:'started',presentation:{actor:{displayName:'Cat',emoji:'🐱'},thread:{shortId:'thread'}}},
  {kind:'execution_status',executionId:'run',threadId:'thread',deliveryId:'blocked',state:'blocked',reason:'provider unavailable'},
  {kind:'execution_status',executionId:'run',threadId:'thread',deliveryId:'resumed',state:'resumed'},
  {kind:'execution_status',executionId:'run',threadId:'thread',deliveryId:'settled',state:'settled',chainDone:true,outcome:'failed'}];
 for(const input of events)assert.deepEqual(await delivery(input),{deliveryId:input.deliveryId});
 assert.equal(seen.length,4);assert.equal(isPluginDeliveryInput({...events[2],lifecycleId:'second identity'}),false);
 await assert.rejects(delivery({...events[2],kind:'other'}),/invalid plugin delivery/);
 await assert.rejects(defineDeliveryAction(()=>({deliveryId:'wrong'}))(events[2]),/receipt/);
});

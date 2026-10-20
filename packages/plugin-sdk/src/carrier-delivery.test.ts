import assert from 'node:assert/strict';
import test from 'node:test';
import {PassThrough} from 'node:stream';
import {startStandaloneHost} from './standalone-host.js';
import {getRegistryRow,validateMessagingRowInput,validateMessagingRowResult,type PluginDeliveryInput} from '@clowder-ai/plugin-contract';
const manifest={pluginId:'example.carrier',version:'1.0.0',contractVersion:'0.1.0',name:'Carrier',features:[{id:'carrier',name:'Carrier',resources:[],capabilities:[]}],runtime:{transport:'stdio',entrypoint:'dist/index.js'}};
const status:PluginDeliveryInput={kind:'execution_status',deliveryId:'d1',executionId:'e1',threadId:'t1',state:'resumed'};
test('carrier has one delivery row and one bounded stream row',()=>{
 assert.equal(getRegistryRow('host.messaging.lifecycle'),undefined);
 assert.equal(getRegistryRow('media.read'),undefined);
 assert.equal(getRegistryRow('streams.read')?.grant,'streams.read');
 assert.equal(validateMessagingRowInput('host.messaging.deliver',status).valid,true);
 assert.equal(validateMessagingRowResult('host.messaging.deliver',{deliveryId:'d1'}).valid,true);
});
test('stdio routes execution feedback through delivery and verifies its receipt',async()=>{
 const input=new PassThrough(),output=new PassThrough();let seen:unknown;
 const channel=startStandaloneHost({manifest,input,output,delivery:async value=>{seen=value;return {deliveryId:value.deliveryId};}});
 try{
  const response=new Promise<string>(resolve=>output.once('data',chunk=>resolve(String(chunk))));
  input.write(JSON.stringify({jsonrpc:'2.0',id:'call1',method:'host.messaging.deliver',params:{meta:{deadlineUnixMs:Date.now()+10000},input:status}})+'\n');
  assert.deepEqual(JSON.parse(await response),{jsonrpc:'2.0',id:'call1',result:{deliveryId:'d1'}});assert.deepEqual(seen,status);
 }finally{channel.close();}
});
test('stdio rejects a receipt for another delivery',async()=>{
 const input=new PassThrough(),output=new PassThrough();
 const channel=startStandaloneHost({manifest,input,output,delivery:()=>({deliveryId:'wrong'})});
 try{
  const response=new Promise<string>(resolve=>output.once('data',chunk=>resolve(String(chunk))));
  input.write(JSON.stringify({jsonrpc:'2.0',id:'call2',method:'host.messaging.deliver',params:{meta:{deadlineUnixMs:Date.now()+10000},input:status}})+'\n');
  const frame=JSON.parse(await response);assert.equal(frame.error.data.reason,'PLUGIN_INTERNAL');
 }finally{channel.close();}
});

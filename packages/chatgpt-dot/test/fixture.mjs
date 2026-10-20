import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDotPlugin} from '../src/plugin-entrypoint.ts';

const hash=value=>createHash('sha256').update(value).digest('hex');
const secret='whsec_'+Buffer.alloc(32,1).toString('base64');
export function fixture(t) {
  const records=new Map(),messages=new Map(),threads=new Map(),sent=[],webhooks=[];let seq=0;
  const storage={async get(k){return structuredClone(records.get(k));},async list(){return Object.fromEntries(records);},
    async set(k,v){const revision=++seq;records.set(k,{revision,value:structuredClone(v)});return {revision};},
    async compareAndSet(k,r,v){if((records.get(k)?.revision??null)!==r)return {applied:false};return {applied:true,...await this.set(k,v)};},
    async delete(k,r){if(r!==undefined&&records.get(k)?.revision!==r)return {deleted:false};return {deleted:records.delete(k)};}};
  const host={pluginInstanceId:'installed-dot-1',storage,config:{get:async()=>undefined},secrets:{get:async()=>undefined},
    messaging:{get:async id=>messages.get(id)??null,send:async input=>{let row=sent.find(x=>x.input.idempotencyKey===input.idempotencyKey);if(!row){row={input:structuredClone(input),messageId:'reply-'+sent.length};sent.push(row);messages.set(row.messageId,{...source,id:row.messageId,threadId:input.threadId,content:input.payload.elements[0]?.payload.text??'',sourceRevision:'reply-rev'});}return {messageId:row.messageId,threadId:input.threadId};},subscribe:async()=>assert.fail('Dot must not subscribe globally'),unsubscribe:async()=>{}},
    threads:{get:async id=>id==='thread-1'?{id,title:'Test',deepLinkUrl:'/thread-1'}:threads.get(id)??null,create:async input=>{const thread={id:'test-thread-'+threads.size,title:input.title,deepLinkUrl:'/test'};threads.set(thread.id,thread);return thread;},readMessages:async()=>[],getCats:async()=>({participants:[{catId:'cat-1'}],routableNow:[{catId:'cat-1'}],routableNotJoined:[],notRoutable:[]})},
    streams:{async *read(){yield Buffer.from('attachment');}},log(){},dataPath:''};
  const source={id:'source-1',threadId:'thread-1',userId:'owner',catId:null,content:'hello Dot',mentions:[],timestamp:1,sourceRevision:'rev-1'};messages.set(source.id,source);
  const owner={kind:'owner-operation',userId:'owner',pluginInstanceId:host.pluginInstanceId,operationKey:'connection',actionId:'begin',requestId:'req',signal:new AbortController().signal,assertCurrent:async()=>{}};
  const sendWebhook=async(url,headers,body,signal)=>{signal?.throwIfAborted();const data=JSON.parse(body);webhooks.push({url,headers,data});return {status:200,body:JSON.stringify(data.type==='verification'?{challenge:data.challenge}:{})};};
  return {host,owner,source,messages,records,sent,webhooks,sendWebhook};
}
export function delivery(f,id='delivery-1') {return {kind:'message',deliveryId:id,threadId:'thread-1',envelope:{messageId:'source-1',threadId:'thread-1',revision:1,actor:{kind:'user',id:'owner'},audience:{kind:'public'},occurredAt:'2026-10-20T11:00:00.000Z',payload:{provenance:{origin:{kind:'host'},epistemicStatus:'observation'},elements:[{elementId:'t',kind:'text',payload:{text:'hello Dot'}}]}}};}
export async function paired(t) {
 const f=fixture(t);f.host.dataPath=await mkdtemp(join(tmpdir(),'dot-plugin-test-'));t.after(()=>rm(f.host.dataPath,{recursive:true,force:true}));
 f.module=createDotPlugin({sendWebhook:f.sendWebhook});f.settings=await f.module.settings(f.host);
 const begun=await f.settings.actions['dot.begin']({},undefined,f.owner);f.credentials=begun.data;
 f.active=await f.module.start(f.host);t.after(()=>f.active.stop({reason:'test'}));
 await f.active.actions['dot.rpc']({request:{method:'POST',path:'mcp',headers:{'x-dot-credential':f.credentials.credentialSecret},body:{jsonrpc:'2.0',id:1,method:'events/subscribe',params:{name:'dot.summoned',arguments:{attempt_id:f.credentials.attemptId,pairing_code:f.credentials.pairingCode},delivery:{mode:'webhook',url:'https://callbacks.example/dot',secret},ttlMs:null}}}});
 return f;
}
export async function rpc(f,name,args){const r=await f.active.actions['dot.rpc']({request:{method:'POST',path:'mcp',headers:{'x-dot-credential':f.credentials.credentialSecret},body:{jsonrpc:'2.0',id:2,method:'tools/call',params:{name,arguments:args}}}});return r.body;}


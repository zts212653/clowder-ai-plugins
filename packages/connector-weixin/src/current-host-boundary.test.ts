import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {parse} from 'yaml';
import {createWeixinPluginModule} from './plugin-entrypoint.js';
import type {WeixinConnectorRuntime,WeixinHostInboundMessage} from './runtime.js';
import type {WeixinAdapter} from './WeixinAdapter.js';

test('fresh ordinary Host ports carry first private message and retryable source streams directly through the current SDK',async()=>{
 const state=new Map<string,{revision:number;value:unknown}>(),threads=new Map<string,any>();
 let inbound!:(value:WeixinHostInboundMessage)=>Promise<void>;let token='first';const tokens:string[]=[];let stops=0,downloads=0;
 const sent:any[]=[];const replies:any[]=[];
 const module=createWeixinPluginModule(options=>{
  inbound=options.host.deliver;tokens.push(options.config.botToken);
  return {outbound:{async downloadInboundMedia(){downloads++;return Buffer.from('source bytes');},async sendReply(...args:unknown[]){replies.push(args);},async sendMedia(){}},
   async start(){},async stop(){stops++;},isConnected(){return true;}} as unknown as WeixinConnectorRuntime<WeixinAdapter>;
 });
 const host={pluginInstanceId:'isolated-instance',dataPath:'/isolated/weixin',config:{get:async()=>undefined},secrets:{get:async()=>token},
  storage:{get:async(key:string)=>state.get(key),list:async()=>Object.fromEntries(state),
   set:async(key:string,value:unknown)=>{const revision=(state.get(key)?.revision??0)+1;state.set(key,{revision,value});return {revision};},
   compareAndSet:async(key:string,revision:number|null,value:unknown)=>{if((state.get(key)?.revision??null)!==revision)return {applied:false};const next=(revision??0)+1;state.set(key,{revision:next,value});return {applied:true,revision:next};},
   delete:async(key:string)=>({deleted:state.delete(key)})},
  threads:{get:async(id:string)=>threads.get(id)??null,create:async(input:any)=>{const id=`thread-${threads.size+1}`;const row={id,title:input.title,deepLinkUrl:`https://local/thread/${id}`,createdAt:1,lastActiveAt:1,preferredCats:[],featureRefs:[]};threads.set(id,row);return row;},
   list:async()=>[...threads.values()],getCats:async()=>({participants:[],routableNow:[],routableNotJoined:[],notRoutable:[]}),readMessages:async()=>[],update:async()=>{throw new Error('unused');},addParticipants:async()=>{throw new Error('unused');}},
  tasks:{},streams:{read:async function*(){yield new Uint8Array([1]);}},
  messaging:{get: async () => null,send:async(input:any)=>{sent.push(input);return {messageId:`message-${sent.length}`,threadId:input.threadId};},subscribe:async()=>{},unsubscribe:async()=>{}},log(){}};
 const manifest=parse(await readFile(new URL('../plugin.yaml',import.meta.url),'utf8'));
 const active=await module.create(manifest).start(host as never);
 await inbound({externalConversationId:'chat',externalSenderId:'sender',providerMessageId:'first',text:'hello',attachments:[{type:'image',platformKey:'private-provider-reference'}]});
 assert.equal(sent.length,1);assert.equal(state.has('connector.permissions.v1'),false,'ordinary first message must not initialize a second permission state');
 assert.deepEqual([...threads.keys()],['thread-1']);
 assert.equal(Object.hasOwn(active.actions,'weixin.media-source.read'),false);
 const reference=sent[0].payload.elements.find((row:any)=>row.kind==='media_ref').payload.reference;
 for(let retry=0;retry<2;retry++) {
  const bytes=[];for await(const chunk of active.streams!.read(reference))bytes.push(...chunk);
  assert.equal(Buffer.from(bytes).toString(),'source bytes');assert.equal(state.has(`media-source/${reference}`),true);
 }
 assert.equal(downloads,2,'each completed reader releases its temporary provider cache');
 const receipt=await active.actions['weixin.outbound']!({kind:'message',deliveryId:'delivery',threadId:'thread-1',
  presentation:{actor:{displayName:'Cat',emoji:'🐱'},thread:{shortId:'one'}},envelope:{messageId:'cat-message',revision:1,threadId:'thread-1',actor:{kind:'cat',id:'cat'},audience:{kind:'public'},occurredAt:'2026-10-17T00:00:00.000Z',
   payload:{provenance:{origin:{kind:'host'},epistemicStatus:'observation'},elements:[{elementId:'text',kind:'text',payload:{text:'reply'}}]}}});
 assert.deepEqual(receipt,{deliveryId:'delivery'});assert.equal(replies.length,1);
 token='second';await active.configRefresh!();assert.deepEqual(tokens,['first','second']);assert.equal(stops,1);
 await active.preStop!({reason:'disabled',deadline:Date.now()+1000});await active.stop({reason:'disabled'});assert.equal(stops,2);
 await assert.rejects(async()=>active.actions['weixin.outbound']!({kind:'message'}),/revoked/);
});

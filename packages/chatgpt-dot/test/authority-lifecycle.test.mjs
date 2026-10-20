import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {randomBytes} from 'node:crypto';
import {paired,rpc,delivery,fixture} from './fixture.mjs';
import {createDotPlugin} from '../src/plugin-entrypoint.ts';
import {CONNECTION_KEY,eventKey} from '../src/store.ts';

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
function call(f,name,args,context){return f.active.actions['dot.rpc']({request:{method:'POST',path:'mcp',headers:{},body:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}}},undefined,context);}

for(const operation of ['read','reply','image','ask'])test(`shared ${operation} retains its owner fence across awaited Host work`,async t=>{
 const f=await paired(t);await f.active.actions.deliverMessage(delivery(f));const id=f.webhooks.at(-1).data.eventId;
 if(operation!=='read')await rpc(f,'cat_cafe_dot_read_source',{event_id:id});
 const entered=deferred(),release=deferred(),controller=new AbortController();let current=true;
 const context={...f.owner,kind:'owner-http-request',operation:'write',signal:controller.signal,assertCurrent:async()=>{if(!current)throw new Error('owner_fence_revoked');}};
 let name,args;
 if(operation==='read'){
  f.host.threads.readMessages=async()=>{entered.resolve();await release.promise;return[];};
  name='cat_cafe_dot_read_source';args={event_id:id};
 }else if(operation==='reply'){
  const get=f.host.messaging.get;f.host.messaging.get=async source=>{const value=await get(source);entered.resolve();await release.promise;return value;};
  name='cat_cafe_dot_reply';args={event_id:id,content:'answer'};
 }else if(operation==='image'){
  const get=f.host.storage.get;f.host.storage.get=async key=>{const value=await get(key);if(key.startsWith('dot/image/')){entered.resolve();await release.promise;}return value;};
  name='cat_cafe_dot_publish_image';args={event_id:id,publication_key:'image',png_base64:(await sharp({create:{width:2,height:2,channels:4,background:'red'}}).png().toBuffer()).toString('base64')};
 }else{
  f.host.threads.getCats=async()=>{entered.resolve();await release.promise;return{participants:[{catId:'cat-1'}],routableNow:[{catId:'cat-1'}]};};
  name='cat_cafe_dot_ask';args={attempt_id:f.credentials.attemptId,thread_id:'thread-1',target_cat_ids:['cat-1'],content:'question',client_message_id:'fenced'};
 }
 const pending=call(f,name,args,context);await entered.promise;
 current=false;if(operation==='read')controller.abort(new Error('owner_request_aborted'));release.resolve();
 const outcome=await pending.catch(error=>({error}));assert.ok(outcome.error??outcome.body?.error,'revoked request must fail');
 assert.equal(f.sent.length,0);
 if(operation==='read')assert.equal((await f.host.storage.get(eventKey(id))).value.sourceReadAt,null);
 if(operation==='image')assert.equal([...f.records.keys()].filter(key=>key.startsWith('dot/image/')).length,0);
 if(operation==='ask')assert.equal([...f.records.keys()].filter(key=>key.startsWith('dot/ask/')).length,0);
 assert.equal((await rpc(f,'cat_cafe_dot_read_source',{event_id:id})).error,undefined,'another request keeps its independent authority');
});

test('configured credential reuse cannot keep an old ask alive across reconnect',async t=>{
 const f=await paired(t);f.host.secrets.get=async()=>f.credentials.credentialSecret;
 const entered=deferred(),release=deferred(),getCats=f.host.threads.getCats;
 f.host.threads.getCats=async id=>{entered.resolve();await release.promise;return getCats(id);};
 const pending=rpc(f,'cat_cafe_dot_ask',{attempt_id:f.credentials.attemptId,thread_id:'thread-1',target_cat_ids:['cat-1'],content:'old question',client_message_id:'old-attempt'});
 await entered.promise;
 const next=(await f.settings.actions['dot.reconnect']({},undefined,f.owner)).data;
 assert.equal(next.credentialSecret,f.credentials.credentialSecret);assert.notEqual(next.attemptId,f.credentials.attemptId);
 const state=(await f.host.storage.get(CONNECTION_KEY)).value;
 await f.host.storage.set(CONNECTION_KEY,{...state,pairedAt:Date.now(),subscription:{id:'new',url:'https://callbacks.example/dot',secret:'new-secret',expiresAt:null,verifiedAt:Date.now(),previousSecret:null,rotationUntil:null}});
 release.resolve();const result=await pending;assert.ok(result.error);assert.equal(f.sent.length,0);
});

for(const operation of ['ask','roundtrip'])test(`stop drains an admitted ${operation} Host send`,async t=>{
 const f=await paired(t),entered=deferred(),release=deferred(),send=f.host.messaging.send;
 f.host.messaging.subscribe=async()=>{};
 f.host.messaging.send=async input=>{entered.resolve();await release.promise;return send(input);};
 const pending=operation==='ask'?rpc(f,'cat_cafe_dot_ask',{attempt_id:f.credentials.attemptId,thread_id:'thread-1',target_cat_ids:['cat-1'],content:'question',client_message_id:'drain'}):f.active.actions['dot.roundtrip']({},undefined,f.owner);
 const completed=pending.catch(error=>({error}));await entered.promise;
 let stopped=false;const stop=f.active.stop({reason:'disabled'}).then(()=>{stopped=true;});
 await new Promise(resolve=>setImmediate(resolve));const stoppedEarly=stopped;
 release.resolve();await completed;await stop;assert.equal(stoppedEarly,false,'stop must wait for the admitted write');assert.equal(stopped,true);
});

test('repeated owner disconnect preserves the first imported revocation timestamp',async t=>{
 const f=await paired(t),state=(await f.host.storage.get(CONNECTION_KEY)).value;
 await f.host.storage.set(CONNECTION_KEY,{...state,revokedAt:123});
 await f.settings.actions['dot.disconnect']({},undefined,f.owner);
 await f.settings.actions['dot.disconnect']({},undefined,f.owner);
 assert.equal((await f.host.storage.get(CONNECTION_KEY)).value.revokedAt,123);
});

for(const reuseCredential of [false,true])test(`follow-up cannot cross a pairing generation while ask lookup waits (credential reuse=${reuseCredential})`,async t=>{
 const f=await paired(t);f.host.messaging.subscribe=async()=>{};
 if(reuseCredential)f.host.secrets.get=async()=>f.credentials.credentialSecret;
 const question=(await rpc(f,'cat_cafe_dot_ask',{attempt_id:f.credentials.attemptId,thread_id:'thread-1',target_cat_ids:['cat-1'],content:'old question',client_message_id:'followup-race'})).result.structuredContent;
 const reply={...f.source,id:'cat-followup',catId:'cat-1',replyTo:question.messageId};f.messages.set(reply.id,reply);
 const entered=deferred(),release=deferred(),list=f.host.storage.list;
 f.host.storage.list=async()=>{const result=await list();entered.resolve();await release.promise;return result;};
 const pending=f.active.actions['dot.followup']({...delivery(f,'stale-followup'),envelope:{...delivery(f).envelope,messageId:reply.id}}).catch(error=>({error}));
 await entered.promise;
 const next=(await f.settings.actions['dot.reconnect']({},undefined,f.owner)).data;
 const state=(await f.host.storage.get(CONNECTION_KEY)).value;
 await f.host.storage.set(CONNECTION_KEY,{...state,pairedAt:Date.now(),subscription:{id:'new',url:'https://new-callback.example/dot',secret:'whsec_'+Buffer.alloc(32,2).toString('base64'),expiresAt:null,verifiedAt:Date.now(),previousSecret:null,rotationUntil:null}});
 assert.notEqual(next.attemptId,f.credentials.attemptId);
 release.resolve();const result=await pending;
 assert.equal(f.webhooks.filter(item=>item.data.name==='dot.summoned').length,0,'a reply to the retired question must never reach the new callback');
 assert.ok(result.error,'the matched old pairing must be rejected');
 assert.equal([...f.records.keys()].filter(key=>key.startsWith('dot/dispatch/')).length,0);
});

for(const failure of ['read rejection','invalid proxy'])test(`failed settings initialization cleans up start and permits retry: ${failure}`,async t=>{
 const f=fixture(t),module=createDotPlugin();let reads=0;
 f.host.config.get=async()=>{if(++reads!==2)return undefined;if(failure==='read rejection')throw new Error('config_read_failed');return 'https://proxy.example:443';};
 await assert.rejects(()=>module.start(f.host),failure==='read rejection'?/config_read_failed/:/proxy/);
 f.host.config.get=async()=>undefined;
 const active=await module.start(f.host);t.after(()=>active.stop({reason:'test'}));
 await active.stop({reason:'disabled'});
 await assert.rejects(()=>active.actions.deliverMessage(delivery(f)),/stopped|revoked/);
});

for(const transition of ['reconnect','disconnect'])for(const operation of ['reply','image','callback','stream'])test(`${transition} during the final ${operation} source read prevents any later publication`,async t=>{
 const f=await paired(t);f.host.secrets.get=async()=>f.credentials.credentialSecret;
 await f.active.actions.deliverMessage(delivery(f));const eventId=f.webhooks.at(-1).data.eventId;
 await rpc(f,'cat_cafe_dot_read_source',{event_id:eventId});
 const imageArgs={event_id:eventId,publication_key:'pairing-fence',png_base64:(await sharp({create:{width:2,height:2,channels:4,background:'red'}}).png().toBuffer()).toString('base64')};
 let reference;if(operation==='stream')reference=(await rpc(f,'cat_cafe_dot_publish_image',imageArgs)).result.structuredContent.reference;
 const sentBefore=f.sent.length,callbacksBefore=f.webhooks.length,entered=deferred(),release=deferred(),get=f.host.messaging.get;
 const finalRead={reply:2,image:3,callback:3,stream:1}[operation];let reads=0;
 f.host.messaging.get=async id=>{const result=await get(id);if(++reads===finalRead){entered.resolve();await release.promise;}return result;};
 const chunks=[];
 const pending=(operation==='reply'?rpc(f,'cat_cafe_dot_reply',{event_id:eventId,content:'late answer'}):operation==='image'?rpc(f,'cat_cafe_dot_publish_image',imageArgs):operation==='callback'?f.active.actions.deliverMessage(delivery(f,'new-delivery')):(async()=>{for await(const chunk of f.active.streams.read(reference))chunks.push(chunk);})()).catch(error=>({error}));
 await entered.promise;
 await f.settings.actions[`dot.${transition}`]({},undefined,f.owner);
 if(transition==='reconnect'){
  const state=(await f.host.storage.get(CONNECTION_KEY)).value;
  await f.host.storage.set(CONNECTION_KEY,{...state,pairedAt:Date.now(),subscription:{id:'new',url:'https://new-callback.example/dot',secret:'whsec_'+Buffer.alloc(32,2).toString('base64'),expiresAt:null,verifiedAt:Date.now(),previousSecret:null,rotationUntil:null}});
 }
 release.resolve();const result=await pending;
 assert.equal(f.sent.length,sentBefore,'a retired pairing must not publish into the Host');
 assert.equal(f.webhooks.length,callbacksBefore,'a retired pairing must not send a callback');
 assert.equal(chunks.length,0,'a retired pairing must not yield original bytes');
 assert.ok(result?.error,'the stale operation must reject');
});

test('disconnect during the final thread source lookup prevents a reply',async t=>{
 const f=await paired(t);await f.active.actions.deliverMessage(delivery(f));const eventId=f.webhooks.at(-1).data.eventId;
 await rpc(f,'cat_cafe_dot_read_source',{event_id:eventId});
 const entered=deferred(),release=deferred(),get=f.host.threads.get;let reads=0;
 f.host.threads.get=async id=>{const result=await get(id);if(++reads===2){entered.resolve();await release.promise;}return result;};
 const pending=rpc(f,'cat_cafe_dot_reply',{event_id:eventId,content:'late answer'});await entered.promise;
 await f.settings.actions['dot.disconnect']({},undefined,f.owner);release.resolve();
 const result=await pending;assert.equal(f.sent.length,0);assert.ok(result.error);
});

test('original stream rechecks its pairing before each subsequent chunk',async t=>{
 const f=await paired(t);await f.active.actions.deliverMessage(delivery(f));const eventId=f.webhooks.at(-1).data.eventId;
 await rpc(f,'cat_cafe_dot_read_source',{event_id:eventId});
 const png=await sharp(randomBytes(256*256*4),{raw:{width:256,height:256,channels:4}}).png().toBuffer();
 const image=(await rpc(f,'cat_cafe_dot_publish_image',{event_id:eventId,publication_key:'chunked-pairing',png_base64:png.toString('base64')})).result.structuredContent;
 const iterator=f.active.streams.read(image.reference)[Symbol.asyncIterator]();t.after(()=>iterator.return?.());
 assert.equal((await iterator.next()).value.length,64*1024);
 await f.settings.actions['dot.disconnect']({},undefined,f.owner);
 await assert.rejects(()=>iterator.next(),/stale|credential|revoked|subscription/);
});

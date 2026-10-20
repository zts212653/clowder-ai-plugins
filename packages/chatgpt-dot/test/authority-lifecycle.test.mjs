import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {paired,rpc,delivery} from './fixture.mjs';
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

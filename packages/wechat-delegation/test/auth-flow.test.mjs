import assert from 'node:assert/strict';import test from 'node:test';
import {AuthFlow}from'../src/auth-flow.mjs';import{NativeRequestError}from'../src/native-stdio.mjs';
function storage(){const data=new Map();return{get:async k=>structuredClone(data.get(k)),compareAndSet:async(k,r,value)=>{const row=data.get(k);if((row?.revision??null)!==r)return{applied:false};data.set(k,{revision:(row?.revision??0)+1,value:structuredClone(value)});return{applied:true};},data};}
const owner=()=>({userId:'owner',signal:new AbortController().signal,assertCurrent:async()=>{}});
const meta=(id,phase='pending')=>({id,generation:1,accountGeneration:0,phase,accountIdentity:null,startedAtMs:1,updatedAtMs:2,authenticationMayHaveOccurred:false});
function fixture(overrides={}){
 const calls=[];const data=storage();const client={instanceId:'process-one',storeId:'store-one',identity:async()=>({serverId:'process-one',nativeStoreId:'store-one',accountGeneration:0,accountIdentity:null,credentialsAvailable:false,connected:false}),
 startLogin:async id=>{calls.push(['start',id]);return{operation:meta(id),qr:null};},loginOperation:async id=>{calls.push(['query',id]);return{operation:meta(id),qr:null};},pollLogin:async id=>({operation:meta(id),qr:null}),cancelLogin:async id=>({operation:meta(id,'cancelled'),qr:null}),...overrides};
 const options={storage:data,getClient:()=>client,assertOwner:async context=>{if(context?.userId!=='owner')throw Error('owner required');context.signal.throwIfAborted();await context.assertCurrent();}};
 return{flow:new AuthFlow(options),options,client,calls,storage:data};
}
test('one persistent intent precedes native write; concurrent begin and polling never create another QR',async()=>{
 let release;const pending=new Promise(r=>release=r);const f=fixture({startLogin:id=>{f.calls.push(['start',id]);return pending;}});
 const [a,b]=await Promise.all([f.flow.begin('login',owner()),f.flow.begin('login',owner())]);assert.equal(a.operationId,b.operationId);assert.equal(f.calls.length,1);
 assert.equal(a.state,'requesting');assert.equal([...f.storage.data.values()][0].value.intents[a.operationId].submitted,true);
 release({operation:meta(a.operationId),qr:{pngBase64:'iVBORw0KGgo=',expiresAt:123}});await f.flow.drain();
 const page=await f.flow.poll(owner());assert.equal(page.operationId,a.operationId);assert.equal(page.qr,'data:image/png;base64,iVBORw0KGgo=');
 await f.flow.drain();assert.equal(f.calls.filter(c=>c[0]==='start').length,1);
});
test('unknown authentication always queries its original id, including after restart and missing native operation',async()=>{
 const f=fixture({startLogin:async id=>{f.calls.push(['start',id]);throw new NativeRequestError('request_unknown',true);},loginOperation:async id=>{f.calls.push(['query',id]);throw new NativeRequestError('invalid_operation',false);}});
 const first=await f.flow.begin('login',owner());await f.flow.drain();assert.equal((await f.flow.status()).state,'unknown');
 await f.flow.begin('login',owner());await f.flow.drain();assert.equal(f.calls.filter(c=>c[0]==='start').length,1);
 f.flow.deactivate();const restored=new AuthFlow(f.options);await restored.poll(owner());await restored.drain();
 assert.equal((await restored.status()).state,'unknown');assert.equal(f.calls.every(c=>c[1]===first.operationId),true);
});
test('cancelling before physical admission persists local cancellation and prevents a late owner check from starting login',async()=>{
 const f=fixture();let checked,release;const entered=new Promise(r=>checked=r),authority=new Promise(r=>release=r);
 const context=owner();let checks=0;context.assertCurrent=async()=>{if(++checks===2){checked();await authority;}};
 const beginning=f.flow.begin('login',context);await entered;
 const cancelled=await f.flow.cancel(owner(),(await f.flow.status()).operationId);assert.equal(cancelled.state,'cancelled');release();await beginning;await f.flow.drain();
 assert.equal(f.calls.filter(c=>c[0]==='start').length,0);
});
test('QR remains ephemeral, raw account fields never persist, and another owner cannot read or continue auth',async()=>{
 const f=fixture({startLogin:async id=>({operation:{...meta(id),authSnapshot:'SENTINEL_ACCOUNT_SECRET'},qr:{pngBase64:'iVBORw0KGgo=',expiresAt:123}})});
 await f.flow.begin('login',owner());await f.flow.drain();assert.equal(JSON.stringify([...f.storage.data.values()]).includes('SENTINEL'),false);assert.equal(JSON.stringify([...f.storage.data.values()]).includes('pngBase64'),false);
 assert.equal(Object.hasOwn(await f.flow.status(),'qr'),false);
 await assert.rejects(f.flow.poll({...owner(),userId:'another'}));await assert.rejects(f.flow.cancel({...owner(),userId:'another'},(await f.flow.status()).operationId));
});

test('saved-session recovery is explicit and a cancellation cannot be overwritten by late active observations',async()=>{
 const f=fixture();let finish;const remote=new Promise(r=>finish=r);let resumes=0,cancels=0;
 f.client.identity=async()=>({serverId:'process-one',nativeStoreId:'store-one',accountGeneration:5,accountIdentity:'owner-wx',credentialsAvailable:true,connected:false});
 const record=(id,phase)=>({id,sourceGeneration:5,accountGeneration:6,accountIdentity:'owner-wx',phase,authenticationMayHaveOccurred:true,startedAtMs:1,updatedAtMs:2});
 f.client.resume=(id,identity)=>{resumes++;assert.equal(identity.accountGeneration,5);return remote;};
 f.client.cancelResume=async id=>{cancels++;return record(id,'cancelled');};
 assert.equal((await f.flow.status()).state,'idle');assert.equal(resumes,0);
 const started=await f.flow.begin('resume',owner());assert.equal(started.authenticationMayHaveOccurred,true);assert.equal(resumes,1);
 await f.flow.cancel(owner(),started.operationId);await new Promise(r=>setImmediate(r));
 finish(record(started.operationId,'authenticating'));await f.flow.drain();
 assert.equal((await f.flow.status()).state,'cancelled');assert.equal(cancels,1);
 await assert.rejects(f.flow.begin('login',owner()),/恢复|断开/);
});
test('legacy backend metadata stays interrupted and preserved; new code never queries the retired operation',async()=>{
 const f=fixture();await f.storage.compareAndSet('wechat-login.v1',null,{nonce:'old-login',ownerUserId:'owner',state:'awaiting_scan',operationId:'old-provider-op',authSnapshot:'SENTINEL_LEGACY_SECRET'});
 const legacy=await f.flow.status();assert.equal(legacy.legacy,true);assert.equal(legacy.state,'interrupted');assert.equal(f.calls.length,0);
 const next=await f.flow.begin('login',owner());await f.flow.drain();assert.notEqual(next.operationId,legacy.operationId);
 const journal=(await f.storage.get('wechat-auth.v2')).value;assert.equal(Object.keys(journal.intents).length,2);assert.equal(JSON.stringify(journal).includes('SENTINEL'),false);
 assert.equal((await f.storage.get('wechat-login.v1')).value.authSnapshot,'SENTINEL_LEGACY_SECRET');
});
test('deactivation leaves native uncertainty inspectable after restart without late Host storage access',async()=>{
 let finish;const pending=new Promise(r=>finish=r);const f=fixture({startLogin:()=>pending});
 const started=await f.flow.begin('login',owner());f.flow.deactivate();let accesses=0;
 f.storage.get=async()=>{accesses++;throw Error('revoked');};f.storage.compareAndSet=f.storage.get;
 finish({operation:meta(started.operationId),qr:null});await f.flow.drain();assert.equal(accesses,0);
});

test('an owner abort after durable admission is a known unwritten refusal, not an unrecoverable unknown login',async()=>{
 const f=fixture(),context=owner(),controller=new AbortController();context.signal=controller.signal;
 const save=f.storage.compareAndSet;f.storage.compareAndSet=async(key,revision,state)=>{const result=await save(key,revision,state);if(state.activeId&&state.intents[state.activeId].phase==='requesting')controller.abort();return result;};
 await assert.rejects(f.flow.begin('login',context));await f.flow.drain();
 assert.equal(f.calls.length,0);assert.equal((await f.flow.status()).state,'failed');
});
test('a stale cancellation names its original intent and cannot cancel a later login',async()=>{
 const f=fixture({startLogin:async id=>({operation:meta(id,'cancelled'),qr:null})});
 const first=await f.flow.begin('login',owner());await f.flow.drain();
 f.client.startLogin=async id=>({operation:meta(id),qr:null});const next=await f.flow.begin('login',owner());await f.flow.drain();
 await assert.rejects(f.flow.cancel(owner(),first.operationId),/变化|记录/);assert.equal((await f.flow.status()).operationId,next.operationId);assert.equal((await f.flow.status()).state,'pending');
});

test('the auth journal and typed client complete an owner QR journey through physical private pipes without exposing account state',async t=>{
 const {spawn}=await import('node:child_process'),{once}=await import('node:events');
 const {NativeLinkClient}=await import('../src/link-client.mjs'),{NativeStdioTransport}=await import('../src/native-stdio.mjs');
 for(const mode of ['auth','auth-secret']){
  const child=spawn(process.execPath,[new URL('./fixtures/link-peer.mjs',import.meta.url).pathname,mode],{env:{},stdio:['pipe','pipe','pipe'],shell:false});
  const transport=new NativeStdioTransport(child);t.after(async()=>{transport.close();if(child.exitCode===null&&child.signalCode===null)await once(child,'exit');});
  const client=new NativeLinkClient({transport,pid:child.pid,version:'0.1.0'});await client.handshake();
  const data=storage();const flow=new AuthFlow({storage:data,getClient:()=>client,assertOwner:async ctx=>ctx.assertCurrent(),beforeStart:()=>client.pause()});
  const starting=await flow.begin('login',owner());await flow.drain();
  if(mode==='auth-secret'){assert.equal((await flow.status()).state,'unknown');assert.equal(transport.closed,true);assert.equal(JSON.stringify([...data.data.values()]).includes('SENTINEL'),false);continue;}
  assert.match((await flow.present(owner(),starting.operationId)).qr,/^data:image\/png;base64,/);
  await flow.poll(owner());await flow.drain();assert.equal((await flow.status()).state,'succeeded');assert.equal((await client.identity('clowder')).connected,true);
  assert.equal(JSON.stringify([...data.data.values()]).includes('pngBase64'),false);assert.equal(Object.keys((await data.get('wechat-auth.v2')).value.intents).length,1);
 }
});
test('LAN consent is explicit for the original QR; physical loss of ACK is queried and never uploads again',async t=>{
 const {spawn}=await import('node:child_process'),{once}=await import('node:events');
 const {NativeLinkClient}=await import('../src/link-client.mjs'),{NativeStdioTransport}=await import('../src/native-stdio.mjs');
 for(const mode of ['lan','lan-lost']){
  const child=spawn(process.execPath,[new URL('./fixtures/link-peer.mjs',import.meta.url).pathname,mode],{env:{},stdio:['pipe','pipe','pipe'],shell:false});
  const requests=[],write=child.stdin.write.bind(child.stdin);child.stdin.write=(frame,...args)=>{requests.push(JSON.parse(String(frame)));return write(frame,...args);};
  const transport=new NativeStdioTransport(child,{timeoutMs:150});t.after(async()=>{transport.close();if(child.exitCode===null&&child.signalCode===null)await once(child,'exit');});
  const client=new NativeLinkClient({transport,pid:child.pid,version:'0.1.0'});await client.handshake();
  const data=storage(),flow=new AuthFlow({storage:data,getClient:()=>client,assertOwner:async ctx=>ctx.assertCurrent()});
  const beginning=await flow.begin('login',owner());await flow.drain();
  await assert.rejects(flow.allowLan(owner(),beginning.operationId),/尚未/);
  await flow.poll(owner());await flow.drain();assert.equal((await flow.status()).state,'lan_awaiting_consent');
  assert.equal(requests.some(request=>request.method==='login.allow_lan'),false);
  await flow.allowLan(owner(),beginning.operationId);await flow.drain();
  if(mode==='lan-lost'){
   assert.equal((await flow.status()).state,'unknown');await flow.poll(owner());await flow.drain();
  }
  assert.equal((await flow.status()).state,'lan_verifying');
  await flow.allowLan(owner(),beginning.operationId);await flow.drain();
  assert.equal(requests.filter(request=>request.method==='login.allow_lan').length,1);
  assert.deepEqual(requests.find(request=>request.method==='login.allow_lan').params,{operationId:beginning.operationId});
  await flow.poll(owner());await flow.drain();assert.equal((await flow.status()).state,'succeeded');
  assert.equal(Object.keys((await data.get('wechat-auth.v2')).value.intents).length,1);
 }
});

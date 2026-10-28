import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, stat} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {ModulePluginHostShape, PluginModuleActivationShape, PluginOwnerHttpContext, PluginOwnerOperationContext} from '@clowder-ai/plugin-sdk';
import {parse} from 'yaml';
import entrypoint from '../src/plugin-entrypoint.js';
const manifest=parse(await readFile(new URL('../plugin.yaml',import.meta.url),'utf8'));
async function freePort() {
  const server=createServer(); await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address(); assert.ok(address && typeof address==='object');
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); return address.port;
}
function host(directory:string,port:number):ModulePluginHostShape {
  const data=new Map<string,{revision:number;value:unknown}>();let revision=0;
  return {pluginInstanceId:'installed-instance',dataPath:directory,config:{get:async key=>key==='servicePort'?String(port):undefined},
    secrets:{get:async()=>undefined}, storage:{
      get:async key=>data.get(key),list:async()=>Object.fromEntries(data),
      set:async(key,value)=>{const entry={revision:++revision,value};data.set(key,entry);return entry;},
      compareAndSet:async(key,expected,value)=>{const previous=data.get(key);if((previous?.revision??null)!==expected)return {applied:false};const entry={revision:++revision,value};data.set(key,entry);return {applied:true,...entry};},
      delete:async key=>({deleted:data.delete(key)}),
    },tasks:{list:async()=>[]} as never,threads:{} as never,
    streams:{read:async function*(){}},messaging:{get:async()=>null,subscribe:async()=>{},unsubscribe:async()=>{}} as never,
    members:{get:async()=>null,list:async()=>[]},log(){},
  } as ModulePluginHostShape;
}
async function status(active:PluginModuleActivationShape) {
  return (await active.actions['collective.service.status']!({}) as {data:{url:string;serviceInstanceId:string;bootstrapNeeded:boolean}}).data;
}
function owner():PluginOwnerHttpContext {return {kind:'owner-http-request',userId:'owner',pluginInstanceId:'installed-instance',operation:'write',signal:new AbortController().signal,async assertCurrent(){}};}

test('fresh owner lists accept Host configuration and persisted operation state before bootstrap', async () => {
  const directory=await mkdtemp(join(tmpdir(),'collective-fresh-settings-'));const port=await freePort();
  const active=await entrypoint.create(manifest).start(host(directory,port));
  try {
    assert.equal((await status(active)).bootstrapNeeded,true);
    for(const [operationKey,method] of [['recovery','collective.recovery.list'],['participation','collective.owner.connections'],['work','collective.work.owner.connections']]) {
      const caller:PluginOwnerOperationContext={...owner(),kind:'owner-operation',operationKey:operationKey!,actionId:'list',requestId:'fresh-list'};
      const input={input:{servicePort:String(port),serviceMode:'embedded',remoteServiceUrl:'http://127.0.0.1:15201'},operationState:{currentAction:'list',updatedAt:Date.now()}};
      const result=await active.actions[method!]!(input,undefined,caller) as {render:string;data:{rows:unknown[];empty?:string}};
      assert.equal(result.render,'rows');assert.deepEqual(result.data.rows,[]);
      for(const field of ['userId','connectionId','credential'])
        await assert.rejects(Promise.resolve().then(()=>active.actions[method!]!({...input,input:{...input.input,[field]:'forged'}},undefined,caller)));
      await assert.rejects(Promise.resolve().then(()=>active.actions[method!]!(input)),/owner/i);
      await assert.rejects(Promise.resolve().then(()=>active.actions[method!]!(input,undefined,{...caller,actionId:'foreign'})),/tuple|owner/i);
    }
  } finally {await active.stop({reason:'test'});await rm(directory,{recursive:true,force:true});}
});

test('plugin serves the existing page/assets and login callback from its own listener',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'collective-service-'));const port=await freePort();
  const active=await entrypoint.create(manifest).start(host(directory,port));
  try {
    const current=await status(active);assert.equal(current.url,`http://127.0.0.1:${port}`);assert.equal(current.bootstrapNeeded,true);
    assert.equal(active.actions['collective.http.dispatch'],undefined);
    const page=await fetch(current.url);assert.equal(page.status,200);assert.match(await page.text(),/collective-client\/app.js/);
    const script=await fetch(current.url+'/collective-client/app.js');assert.equal(script.status,200);assert.match(script.headers.get('content-type')??'',/javascript/);
    assert.equal((await fetch(current.url+'/owner-bootstrap.secret')).status,404);
    assert.notEqual((await fetch(current.url+'/api/auth/github/callback')).status,404);
    assert.equal((await fetch(current.url+'/api/meta',{method:'OPTIONS',headers:{origin:'https://untrusted.example'}})).status,403);
    const secret=(await readFile(join(directory,'service/owner-bootstrap.secret'),'utf8')).trim();
    assert.equal((await stat(join(directory,'service/owner-bootstrap.secret'))).mode&0o777,0o600);
    const result=await fetch(current.url+'/api/bootstrap',{method:'POST',headers:{origin:current.url,'content-type':'application/json'},body:JSON.stringify({secret,displayName:'Owner'})});
    assert.equal(result.status,201);assert.equal((await status(active)).bootstrapNeeded,false);
  } finally {await active.stop({reason:'test'});await rm(directory,{recursive:true,force:true});}
});

test('only authenticated owner requests admit Host origins; stop closes listener and restart preserves identity',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'collective-origin-'));const port=await freePort();const source=host(directory,port);
  const plugin=entrypoint.create(manifest);const active=await plugin.start(source);let stopped=false;
  try {
    const current=await status(active);const origin='http://127.0.0.1:5172';
    const request={request:{method:'POST',path:'service/provision',headers:{origin},principal:{kind:'owner',id:'owner'}}};
    await assert.rejects(Promise.resolve(active.actions['collective.control.http']!(request)),/owner/i);
    const launched=await active.actions['collective.control.http']!(request,undefined,owner()) as {status:number;body:{launchUrl:string}};
    assert.equal(launched.status,200);assert.match(launched.body.launchUrl,/^http:\/\/127.0.0.1:\d+#bootstrap=/);
    const cors=await fetch(current.url+'/api/meta',{method:'OPTIONS',headers:{origin}});assert.equal(cors.status,204);assert.equal(cors.headers.get('access-control-allow-origin'),origin);
    await active.stop({reason:'test'});stopped=true;
    await assert.rejects(fetch(current.url));await assert.rejects(Promise.resolve(active.actions['collective.service.status']!({})),/revoked|stopped/);
    const restarted=await plugin.start(source);
    try {assert.equal((await status(restarted)).serviceInstanceId,current.serviceInstanceId);assert.equal((await fetch(current.url+'/api/meta',{method:'OPTIONS',headers:{origin}})).status,204);}
    finally {await restarted.stop({reason:'test'});}
  } finally {if(!stopped)await active.stop({reason:'test'});await rm(directory,{recursive:true,force:true});}
});

test('managed stop owns an established Work-material subscription and restart restores it',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'collective-managed-stop-'));const port=await freePort();
  const subscriptions=new Set<string>();let sessionStopped=false,subscribeCalls=0,unsubscribeCalls=0;
  const source:ModulePluginHostShape={...host(directory,port),tasks:{async list(){return [{
    id:'completed-work',kind:'work',title:'Completed Work',subjectKey:'collective-work:connection:work',
    threadId:'original-thread',ownerCatId:'codex-sol',userId:'owner',createdBy:'system',status:'done',why:'',createdAt:1,updatedAt:2,
  }];}} as never,messaging:{async get(){return null;},async send(){throw new Error('Unused');},
    async subscribe({threadId}:{threadId:string}){if(sessionStopped)throw new Error('Plugin subscription session is stopped');subscribeCalls++;subscriptions.add(threadId);},
    async unsubscribe({threadId}:{threadId:string}){unsubscribeCalls++;if(sessionStopped)throw new Error('Plugin subscription session is stopped');subscriptions.delete(threadId);}} as never};
  const definition=entrypoint.create(manifest);let active:PluginModuleActivationShape|undefined;
  const stopHostSession=()=>{sessionStopped=true;subscriptions.clear();};
  try {
    active=await definition.start(source);assert.deepEqual([...subscriptions],['original-thread']);assert.equal(subscribeCalls,1);
    await active.preStop?.({reason:'owner_disabled',deadline:Date.now()+1000});stopHostSession();
    await active.stop({reason:'owner_disabled'});
    assert.equal(unsubscribeCalls,0,'the stopped Host session is the sole subscription cleanup owner');

    sessionStopped=false;active=await definition.start(source);
    assert.deepEqual([...subscriptions],['original-thread']);assert.equal(subscribeCalls,2);
    await active.preStop?.({reason:'host_shutdown',deadline:Date.now()+1000});stopHostSession();
    await active.stop({reason:'host_shutdown'});
    assert.equal(unsubscribeCalls,0);
  } finally {try {await active?.stop({reason:'test'});} catch {}await rm(directory,{recursive:true,force:true});}
});

test('missing instance data and reserved service port are rejected without opening a listener',async()=>{
  await assert.rejects(entrypoint.create(manifest).start(host('',3001)),/data|port/i);
  const directory=await mkdtemp(join(tmpdir(),'collective-reserved-'));
  try {await assert.rejects(entrypoint.create(manifest).start(host(directory,3001)),/port/i);}
  finally {await rm(directory,{recursive:true,force:true});}
});

test('bootstrap write failure leaves no listener or callable activation',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'collective-bootstrap-failure-'));const port=await freePort();
  try {
    await mkdir(join(directory,'service/owner-bootstrap.secret'),{recursive:true});
    await assert.rejects(entrypoint.create(manifest).start(host(directory,port)));
    await assert.rejects(fetch(`http://127.0.0.1:${port}`));
  } finally {await rm(directory,{recursive:true,force:true});}
});

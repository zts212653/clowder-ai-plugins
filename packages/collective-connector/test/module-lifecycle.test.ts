import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
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

test('embedded restart renews expired first-owner setup without replacing the Service', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'collective-expired-bootstrap-'));
  const port = await freePort();
  const source = host(directory, port);
  const plugin = entrypoint.create(manifest);
  let active = await plugin.start(source);
  let stopped = false;
  try {
    const first = await status(active);
    const secretPath = join(directory, 'service/owner-bootstrap.secret');
    const old = (await readFile(secretPath, 'utf8')).trim();
    await active.stop({ reason: 'test restart' }); stopped = true;
    const path = join(directory, 'service/collective-service.json');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    saved.bootstrap.expiresAt = new Date(Date.now() - 1000).toISOString();
    await writeFile(path, JSON.stringify(saved));
    active = await plugin.start(source); stopped = false;
    assert.equal((await status(active)).serviceInstanceId, first.serviceInstanceId);
    const fresh = (await readFile(secretPath, 'utf8')).trim();
    assert.notEqual(fresh, old);
    const claim = (secret: string) => fetch(first.url + '/api/bootstrap', {
      method: 'POST', headers: { origin: first.url, 'content-type': 'application/json' },
      body: JSON.stringify({ secret, displayName: 'Owner' }),
    });
    assert.equal((await claim(old)).status, 401);
    assert.equal((await claim(fresh)).status, 201);
    assert.equal((await status(active)).bootstrapNeeded, false);
  } finally {
    if (!stopped) await active.stop({ reason: 'test' });
    await rm(directory, { recursive: true, force: true });
  }
});
function owner():PluginOwnerHttpContext {return {kind:'owner-http-request',userId:'owner',pluginInstanceId:'installed-instance',operation:'write',signal:new AbortController().signal,async assertCurrent(){}};}

test('authenticated Open Collective recovers after a day of uptime without restarting', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'collective-open-expired-'));
  const port = await freePort();
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const active = await entrypoint.create(manifest).start(host(directory, port));
  const request = { request: { method: 'POST', path: 'service/provision', headers: {}, principal: { kind: 'owner', id: 'owner' } } };
  const open = () => active.actions['collective.control.http']!(request, undefined, owner()) as Promise<{ status: number; body: { launchUrl: string } }>;
  const secret = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('bootstrap');
  try {
    const first = await status(active);
    const original = await open();
    assert.equal((await open()).body.launchUrl, original.body.launchUrl, 'valid links stay valid');
    t.mock.timers.setTime(now + 25 * 60 * 60 * 1000);
    const statePath = join(directory, 'service/collective-service.json');
    const before = await readFile(statePath, 'utf8');
    await assert.rejects(Promise.resolve(active.actions['collective.control.http']!(request)), /owner/i);
    const stale = { ...owner(), async assertCurrent() { throw new Error('expired owner request'); } };
    await assert.rejects(Promise.resolve(active.actions['collective.control.http']!(request, undefined, stale)), /expired/);
    assert.equal(await readFile(statePath, 'utf8'), before);
    const [a, b] = await Promise.all([open(), open()]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(a.body.launchUrl, b.body.launchUrl, 'concurrent opens share one valid credential');
    assert.notEqual(secret(a.body.launchUrl), secret(original.body.launchUrl));
    assert.equal((await status(active)).serviceInstanceId, first.serviceInstanceId);
    const claim = (url: string) => fetch(first.url + '/api/bootstrap', {
      method: 'POST', headers: { origin: first.url, 'content-type': 'application/json' },
      body: JSON.stringify({ secret: secret(url), displayName: 'Owner' }),
    });
    assert.equal((await claim(original.body.launchUrl)).status, 401);
    assert.equal((await claim(a.body.launchUrl)).status, 201);
    const claimed = await readFile(statePath, 'utf8');
    assert.equal((await open()).body.launchUrl, first.url);
    assert.equal(await readFile(statePath, 'utf8'), claimed, 'opening after claim never reopens setup');
  } finally {
    t.mock.timers.reset();
    await active.stop({ reason: 'test' });
    await rm(directory, { recursive: true, force: true });
  }
});

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

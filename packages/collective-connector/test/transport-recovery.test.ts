import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {CollectiveServiceStore} from '../src/business/service/store.js';
import {startCollectiveServer} from '../src/business/service/http-server.js';
import {CollectiveServiceClient,ConnectorTransportError} from '../src/business/connector/service-client.js';
import {createLocalServiceTransport} from '../src/local-service-transport.js';
import {serviceHostConfig} from './runtime-fixture.js';
async function setup() {
 const dir=await mkdtemp(join(tmpdir(),'collective-http-'));const port=Number(await serviceHostConfig().get('servicePort'));
 const origin=`http://127.0.0.1:${port}`;
 const {store,bootstrapSecret}=await CollectiveServiceStore.open({dataDirectory:dir,humanAuthRedirectUri:origin+'/api/auth/github/callback',
  humanAuthProvider:{id:'github',readiness:{ready:true},authorizationUrl:()=> 'https://github.test/auth',authenticate:async()=>({providerSubject:'owner',handle:'owner',displayName:'Owner'})}});
 const server=await startCollectiveServer({store,port,allowedHostOrigins:[origin]});
 return {dir,origin,store,bootstrapSecret,async close(){await server.close();await rm(dir,{recursive:true,force:true});}};
}
test('local requests use the plugin listener and never fall back to a remote transport',async()=>{
 const f=await setup();let stopped=false,remote=0;
 try {
  const transport=createLocalServiceTransport(f.origin,()=>{if(stopped)throw new Error('stopped');},f.store);
  const client=new CollectiveServiceClient(async()=>{remote++;return Response.json({serviceInstanceId:'remote',clientBuildId:'remote'});},10000,transport);
  assert.equal((await client.readMetadata(f.origin)).serviceInstanceId,f.store.getMetadata().serviceInstanceId);assert.equal(remote,0);
  assert.equal((await client.readMetadata('https://remote.example')).serviceInstanceId,'remote');assert.equal(remote,1);
  stopped=true;await assert.rejects(transport.fetch(f.origin),(error:unknown)=>error instanceof ConnectorTransportError&&error.effect==='not_started'&&error.automaticRetry===false);
  await assert.rejects(transport.fetch('https://foreign.example'));assert.equal(remote,1);
 }finally{await f.close();}
});
test('real HTTP rejects foreign origins without mutation and preserves login cookie scope and clear',async()=>{
 const f=await setup();
 try {
  const bytes=await readFile(join(f.dir,'collective-service.json'));
  for(const origin of ['https://evil.example','null'])assert.equal((await fetch(f.origin+'/api/bootstrap',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({secret:f.bootstrapSecret,displayName:'Owner'})})).status,403);
  assert.deepEqual(await readFile(join(f.dir,'collective-service.json')),bytes);
  const bootstrap=await f.store.consumeBootstrap({secret:f.bootstrapSecret!,displayName:'Owner'});
  const attempt=await f.store.beginHumanAuth({provider:'github',intent:{kind:'bind'},sessionToken:bootstrap.sessionToken});
  const callback=await fetch(f.origin+'/api/auth/github/callback?'+new URLSearchParams({state:attempt.state,code:'code'}),{redirect:'manual'});
  assert.equal(callback.status,303);const cookie=callback.headers.get('set-cookie')!;
  assert.match(cookie,/^collective_auth_completion=[A-Za-z0-9_-]{43};/);assert.match(cookie,/HttpOnly; SameSite=Strict; Path=\/api\/auth\/completions\/exchange; Max-Age=300$/);assert.doesNotMatch(cookie,/Domain=/i);
  const exchanged=await fetch(f.origin+'/api/auth/completions/exchange',{method:'POST',headers:{origin:f.origin,'content-type':'application/json',cookie:cookie.split(';')[0]!},body:'{}'});
  assert.equal(exchanged.status,200);assert.match(exchanged.headers.get('set-cookie')!,/^collective_auth_completion=;.*Max-Age=0$/);
 }finally{await f.close();}
});
test('an aborted response cannot roll back an already committed local mutation',async()=>{
 const f=await setup();
 try {
  const abort=new AbortController();const consume=f.store.consumeBootstrap.bind(f.store);
  f.store.consumeBootstrap=async input=>{const committed=await consume(input);abort.abort();return committed;};
  const transport=createLocalServiceTransport(f.origin,()=>{},f.store);
  await assert.rejects(transport.fetch(f.origin+'/api/bootstrap',{method:'POST',headers:{origin:f.origin,'content-type':'application/json'},body:JSON.stringify({secret:f.bootstrapSecret,displayName:'Owner'}),signal:abort.signal}),(error:unknown)=>error instanceof ConnectorTransportError&&error.effect==='unknown'&&error.automaticRetry===false);
  assert.equal(f.store.getMetadata().bootstrapNeeded,false);
 }finally{await f.close();}
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeLinkClient } from '../src/link-client.mjs';
const caps=['stdio-v1','text-protocol-subset','account-login-v1','durable-text-send-v1','durable-text-sync-v1','current-directory-v1','explicit-session-resume-v1','canonical-message-lookup-v1','stable-text-stream-v1','explicit-login-lan-v1'];
const hello=()=>({product:'clowder-wechat-link',version:'0.1.0',pid:123,protocolVersion:1,upstreamCommit:'ed976d78c1e1cc2a49ad17d1e2c0da023bbb5c8e',capabilities:[...caps],nativeApiAvailable:true,accountServiceReady:false});
const status=()=>({serverId:'stable-vault-id',accountGeneration:1,accountIdentity:'synthetic-user',credentialsAvailable:true,authenticated:true,connection:'online',stream:{sourceRef:'stream-one',resetEpoch:0,eventCursor:'0',caughtUp:true},egress:[]});
function fixture() {
  const calls=[];const replies={hello:hello(),status:status()};let closed=false;
  const transport={request:(method,params)=>{calls.push({method,params});return Promise.resolve(structuredClone(replies[method]));},close:()=>{closed=true;}};
  return {client:new NativeLinkClient({transport,pid:123,version:'0.1.0'}),transport,calls,replies,closed:()=>closed};
}
test('typed connection verifies the owned PID, exact version and capabilities; each process gets a fresh identity',async()=>{
  const f=fixture();await f.client.handshake();const identity=await f.client.identity('clowder');
  assert.equal(identity.connected,true);assert.notEqual(identity.serverId,'stable-vault-id');assert.equal(identity.accountGeneration,1);
  const another=new NativeLinkClient({transport:f.transport,pid:123,version:'0.1.0'});await another.handshake();
  assert.notEqual((await another.identity('clowder')).serverId,identity.serverId);
  for(const mutate of [h=>h.pid++,h=>h.version='other',h=>h.capabilities.pop(),h=>h.nativeApiAvailable=false]){
    const bad=fixture();mutate(bad.replies.hello);await assert.rejects(bad.client.handshake());assert.equal(bad.closed(),true);
  }
});
test('closed DTOs reject nested account secrets without forwarding them or reaching a model',async()=>{
  for(const where of ['hello','status']){
    const f=fixture();f.replies[where].authSnapshot={session:'SENTINEL_CREDENTIAL'};
    await assert.rejects(f.client.handshake(),error=>!String(error).includes('SENTINEL'));assert.equal(f.closed(),true);
  }
});
test('the exact admitted lease reaches synchronous submission; stale instances cannot write',async()=>{
  const f=fixture();await f.client.handshake();const identity=await f.client.identity('clowder');
  const lease={accountGeneration:1,conversationGeneration:3,destination:'friend'};
  const run={id:'op',accountId:'clowder',accountIdentity:'synthetic-user',serverId:identity.serverId,nativeStoreId:identity.nativeStoreId,conversationId:'friend',nativeLease:lease,text:'synthetic text'};
  f.replies['text.send']={id:'op',destination:'friend',accountGeneration:1,conversationGeneration:3,state:'accepted',createdAt:1,clientMessageId:2,serverId:'99'};
  const pending=f.client.submit(run);assert.equal(f.calls.at(-1).method,'text.send');assert.deepEqual(f.calls.at(-1).params,{operationId:'op',lease,text:run.text});
  assert.equal((await pending).state,'accepted');
  await assert.rejects(f.client.submit({...run,serverId:'old-instance'}));assert.equal(f.calls.filter(c=>c.method==='text.send').length,1);
  f.replies['send.receipt']={...f.replies['text.send'],destination:'other'};
  await assert.rejects(f.client.inspect(run));assert.equal(f.closed(),true);
});

test('physical child handshake, closed authentication DTO, loss of ACK and exit retain truthful boundaries',async t=>{
  const {spawn}=await import('node:child_process');
  const {once}=await import('node:events');
  const {NativeStdioTransport}=await import('../src/native-stdio.mjs');
  async function childClient(mode){
    const child=spawn(process.execPath,[new URL('./fixtures/link-peer.mjs',import.meta.url).pathname,mode],{stdio:['pipe','pipe','pipe'],shell:false});
    const transport=new NativeStdioTransport(child,{timeoutMs:150});
    t.after(async()=>{transport.close();if(child.exitCode===null&&child.signalCode===null)await once(child,'exit');});
    return {client:new NativeLinkClient({transport,pid:child.pid,version:'0.1.0'}),transport};
  }
  const good=await childClient('normal');await good.client.handshake();
  assert.equal((await good.client.loginOperation('auth-one')).operation.phase,'pending');
  const secret=await childClient('nested-secret');await secret.client.handshake();
  await assert.rejects(secret.client.loginOperation('auth-secret'),e=>e.code==='invalid_response'&&!String(e).includes('SENTINEL'));
  assert.equal(secret.transport.closed,true);
  for(const mode of ['wrong-pid','exit-on-status']){const bad=await childClient(mode);await assert.rejects(bad.client.handshake());}
  const lost=await childClient('lost-ack');await lost.client.handshake();const identity=await lost.client.identity('clowder');
  const run={id:'lost',accountId:'clowder',accountIdentity:identity.accountIdentity,serverId:identity.serverId,nativeStoreId:identity.nativeStoreId,conversationId:'friend',nativeLease:{accountGeneration:1,conversationGeneration:1,destination:'friend'},text:'synthetic'};
  await assert.rejects(lost.client.submit(run),e=>e.code==='request_unknown'&&e.mayHaveCommitted);
});

test('fresh offline and disconnected projections match the Rust account service and permit no submission',async()=>{
  const f=fixture();f.replies.status={...status(),accountGeneration:0,accountIdentity:null,credentialsAvailable:false,authenticated:false,connection:'offline',stream:null};
  await f.client.handshake();assert.equal((await f.client.identity('clowder')).connected,false);
  f.replies['account.disconnect']={serverId:'stable-vault-id',accountGeneration:1,accountIdentity:null,credentialsAvailable:false,authenticated:false,connection:'offline',stream:null};
  await f.client.disconnect('clowder');assert.equal(f.client.account.authenticated,false);
});

test('authentication, directory, sync and message contracts reject extra secret fields at every nesting boundary',async()=>{
  const login={operation:{id:'auth',generation:1,accountGeneration:1,phase:'pending',accountIdentity:null,startedAtMs:1,updatedAtMs:2,authenticationMayHaveOccurred:false,lanApprovalRequested:false,lanDeadlineAtMs:null},qr:null};
  const directory={operationId:'directory',accountGeneration:1,accountIdentity:'synthetic-user',phase:'ready',catalogComplete:true,verifiedCount:1,unverifiedCount:0,groupDiscoveryIncomplete:false,snapshotAvailable:true,observedAt:1,retryAfterMs:0};
  const target={id:'friend',kind:'direct',displayName:'Friend',nickname:null,remark:null,alias:null};
  const message={id:'1:99',accountGeneration:1,accountIdentity:'synthetic-user',threadId:'friend',senderId:null,direction:'incoming',serverId:'99',messageType:1,body:'authorized text',createdAt:1};
  const cases=[
    ['login.operation',login,c=>c.loginOperation('auth'),v=>v.operation],
    ['directory.operation',directory,c=>c.directoryOperation('directory'),v=>v],
    ['directory.page',{directory,items:[target],nextOffset:null},c=>c.directoryPage('directory'),v=>v.items[0]],
    ['sync.pull',{accountGeneration:1,checkpoint:1,eventCursor:'1',more:false,retainedUnprojected:0,reset:false,stream:{sourceRef:'stream-one',resetEpoch:0,eventCursor:'1',caughtUp:true}},c=>c.pull({accountGeneration:1,accountIdentity:'synthetic-user',stream:status().stream}),v=>v],
    ['message.get',message,c=>c.message('clowder','1:99',{accountGeneration:1,...status().stream}),v=>v],
    ['events.page',{items:[{cursor:'1',messageId:'1:99',threadId:'friend',createdAt:1}],nextCursor:'1',more:false},c=>c.events('clowder','0',{accountGeneration:1,...status().stream}),v=>v.items[0]],
    ['session.operation',{id:'resume',sourceGeneration:1,accountGeneration:2,accountIdentity:'synthetic-user',phase:'succeeded',authenticationMayHaveOccurred:true,startedAtMs:1,updatedAtMs:2},c=>c.resumeOperation('resume'),v=>v],
  ];
  for(const [method,valid,call,nested]of cases){
    const good=fixture();await good.client.handshake();good.replies[method]=structuredClone(valid);await call(good.client);
    const bad=fixture();await bad.client.handshake();bad.replies[method]=structuredClone(valid);nested(bad.replies[method]).authSnapshot='SENTINEL_SECRET';
    await assert.rejects(call(bad.client),e=>e.code==='invalid_response'&&!String(e).includes('SENTINEL'));assert.equal(bad.closed(),true);
  }
});

test('the typed consumer exposes asynchronous native directory polling without an HTTP adapter',async()=>{
  const f=fixture();await f.client.handshake();
  f.transport.request=(method,params)=>{
    if(method==='status')return Promise.resolve(status());
    const directory={operationId:params.operationId,accountGeneration:1,accountIdentity:'synthetic-user',phase:'ready',catalogComplete:true,verifiedCount:1,unverifiedCount:0,groupDiscoveryIncomplete:false,snapshotAvailable:true,observedAt:Date.now(),retryAfterMs:0};
    if(method==='directory.start')return Promise.resolve(directory);
    if(method==='directory.page')return Promise.resolve({directory,items:[{id:'friend',kind:'direct',displayName:'Friend',nickname:null,remark:null,alias:null}],nextOffset:null});
    throw Error('unexpected method');
  };
  assert.equal((await f.client.targets('clowder')).pending,true);
  await new Promise(r=>setImmediate(r));
  const page=await f.client.targets('clowder');assert.equal(page.pending,false);assert.equal(page.items[0].accountId,'clowder');
});

test('accepted delivery needs the exact canonical server id, account, destination, direction and body; unknown never searches by text',async()=>{
 const base=fixture();await base.client.handshake();const identity=await base.client.identity('clowder');
 const run={id:'canonical-send',accountId:'clowder',accountIdentity:identity.accountIdentity,serverId:identity.serverId,nativeStoreId:identity.nativeStoreId,conversationId:'friend',nativeLease:{accountGeneration:1,conversationGeneration:2,destination:'friend'},text:'canonical text'};
 const receipt={id:run.id,...run.nativeLease,state:'accepted',createdAt:1,clientMessageId:1,serverId:'18446744073709551615'};
 const message={id:'1:18446744073709551615',accountGeneration:1,accountIdentity:'synthetic-user',threadId:'friend',senderId:null,direction:'outgoing',serverId:receipt.serverId,messageType:1,body:run.text,createdAt:1};
 base.replies['send.receipt']=receipt;base.replies['message.by_server']=message;
 assert.equal((await base.client.inspect(run)).verified,true);assert.equal(base.calls.at(-1).params.serverId,receipt.serverId);
 for(const mutate of [m=>m.serverId='7',m=>m.threadId='other',m=>m.direction='incoming',m=>m.body='other text',m=>m.accountIdentity='other-owner']){
  const f=fixture();await f.client.handshake();f.replies['send.receipt']=receipt;f.replies['message.by_server']=structuredClone(message);mutate(f.replies['message.by_server']);
  await assert.rejects(f.client.inspect({...run,serverId:f.client.instanceId}));assert.equal(f.closed(),true);
 }
 base.replies['send.receipt']={...receipt,state:'needs_review',serverId:null};const count=base.calls.length;
 assert.equal((await base.client.inspect(run)).state,'needs_review');assert.equal(base.calls.length,count+1);
});

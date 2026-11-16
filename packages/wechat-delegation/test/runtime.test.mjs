import assert from 'node:assert/strict';
import test from 'node:test';
import { DelegationRuntime } from '../src/runtime.mjs';

export function memoryStorage() {
  const data = new Map();
  return { get: async key => structuredClone(data.get(key)),
    compareAndSet: async (key, expected, value) => { const old = data.get(key); if ((old?.revision ?? null) !== expected) return { applied: false };
      const row = { revision: (old?.revision ?? 0) + 1, value: structuredClone(value) }; data.set(key, row); return { applied: true, revision: row.revision }; } };
}
export const owner = overrides => ({ kind: 'owner-http-request', userId: 'owner', pluginInstanceId: 'plugin', operation: 'write',
  requestIdentity: { requestId: 'request' }, signal: new AbortController().signal, assertCurrent: async () => {}, ...overrides });
async function fixture(t) {
  const sends = [], logins = []; let prepared = 0;
  const client = {
    json: async () => ({ items: [{ id: 'clowder' }] }),
    identity: async () => ({ serverId: 'server', accountId: 'clowder', accountIdentity: 'wxid_owner', nativeStoreId: 'synthetic-store', accountGeneration: 1, connected: true }),
    account: async () => ({ id: 'clowder', authenticated: true, ownUsername: 'wxid_owner', connection: 'online' }),
    createAccount: async () => ({}),
    targets: async () => ({ items: [{ id: 'room@chatroom', accountId: 'clowder', kind: 'group', displayName: '测试群' }], nextCursor: null }),
    login: async (_id, key) => { logins.push(key); return { id: 'login', kind: 'login', accountId: 'clowder', state: 'awaiting_scan' }; },
    operation: async () => ({ id: 'login', kind: 'login', accountId: 'clowder', state: 'awaiting_scan', result: { qrAvailable: true } }),
    qr: async () => 'data:image/png;base64,aGVsbG8=', prepare: async () => {},
    authorize: async (_account, _identity, destination) => ({accountGeneration:1,conversationGeneration:1,destination}), pause: async () => ({paused:true}),
    submit: async run => { sends.push(run); return { sendId: 'send', state: 'queued' }; },
    inspect: async () => ({ sendId: 'send', state: 'cancelled' }), cancel: async () => ({ sendId: 'send', state: 'cancelled' }),
  };
  const host = { pluginInstanceId: 'plugin', dataPath: '/unused', storage: memoryStorage(),
    members: { list: async () => [{ catId: 'cat', displayName: '测试猫', available: true }] },
    threads: { get: async id => ({ id }), list: async () => [] },
    messaging: { get: async () => null, subscribe: async () => {}, unsubscribe: async () => {} },
  };
  const model = { available: () => true, describe: async () => ({ available: true, fingerprint: 'preview', runtime: { clientId: 'test', model: 'test' } }),
    prepare: async () => ({ sessionId: 's', generation: 1, threadId: 'isolated', consumedCursor: 0 }),
    generate: async () => ({ kind: 'message', text: '今晚有人一起读书吗？' }) };
  const supervisor = { client: null, prepare: async () => { prepared++; supervisor.client = client; return client; }, stopOwned: async current => { if(supervisor.client===current) supervisor.client=null; }, stop: async () => { supervisor.client = null; } };
  const runtime = await DelegationRuntime.open(host, { supervisor, model, startTimer: false });
  t.after(() => runtime.stop());
  return { runtime, sends, logins, host, client, prepared: () => prepared };
}
test('activation is dormant and actions reject forged or stale owner contexts', async t => {
  const f = await fixture(t);
  assert.equal(f.prepared(), 0);
  for (const context of [undefined, owner({ pluginInstanceId: 'foreign' }), owner({ operation: 'read' })])
    await assert.rejects(f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, context), /owner|本人|已登录/);
  assert.equal(f.prepared(), 0);
});
test('owner login retries stay on the original durable operation and never grant conversation access', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  await f.runtime.dispatch({ action: 'login' }, owner());
  await f.runtime.dispatch({ action: 'login' }, owner());
  assert.equal(f.logins.length, 1);
  assert.equal((await f.runtime.status()).policies.length, 0);
  assert.equal(f.sends.length, 0);
});

test('cat selection is independent of reminder lookup and reminder pages respect the real Host limit', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  f.host.threads.list = async ({ limit }) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw Error('limit must be an integer in 1..50');
    return [{ id: 'owner-thread', title: '本人对话' }];
  };
  assert.equal((await f.runtime.dispatch({ action: 'cats' }, owner())).items[0].id, 'cat');
  assert.equal((await f.runtime.dispatch({ action: 'reminder_threads' }, owner())).items[0].id, 'owner-thread');
  f.host.threads.list = async () => { throw Error('reminder directory temporarily unavailable'); };
  await assert.rejects(f.runtime.dispatch({ action: 'reminder_threads' }, owner()), /temporarily unavailable/);
  assert.equal((await f.runtime.dispatch({ action: 'cats' }, owner())).items[0].id, 'cat');
});
test('owner selects a real group and cat, enables delegation, proactively sends then takes over through plugin operations', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  await f.runtime.dispatch({ action: 'activate', accountIdentity: 'wxid_owner', serverId: 'server', target: { id: 'room@chatroom', kind: 'group' }, catId: 'cat', persona: '自然友好',
    goal: '今晚一起读书', proactive: true, replies: true, intervalMinutes: 180, maxTurns: 10, confirm: true, modelFingerprint: 'preview' }, owner());
  const binding = (await f.runtime.status()).policies[0];
  await f.runtime.dispatch({ action: 'initiate', policyId: binding.id, operationId: 'explicit-owner-action' }, owner());
  await f.runtime.drain();
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].conversationId, 'room@chatroom');
  await f.runtime.dispatch({ action: 'takeover', policyId: binding.id }, owner());
  assert.equal((await f.runtime.status()).policies[0].mode, 'owner');
  await assert.rejects(f.runtime.dispatch({ action: 'initiate', policyId: binding.id, operationId: 'after-takeover' }, owner()), /paused|inactive/);
});

test('a changed model preview cannot silently grant a different model service', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  await assert.rejects(f.runtime.dispatch({ action: 'activate', accountIdentity: 'wxid_owner', serverId: 'server', target: { id: 'room@chatroom', kind: 'group' }, catId: 'cat', persona: '自然',
    goal: '读书', proactive: true, replies: true, intervalMinutes: 180, maxTurns: 10, confirm: true, modelFingerprint: 'stale-preview' }, owner()), /模型|model/);
  assert.equal((await f.runtime.status()).policies.length, 0);
});

test('only a canonical human owner stop in the selected Clowder thread can interrupt delegation; redelivery is idempotent', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  await f.runtime.dispatch({ action: 'activate', accountIdentity: 'wxid_owner', serverId: 'server', target: { id: 'room@chatroom', kind: 'group' }, catId: 'cat', persona: '自然',
    goal: '读书', proactive: true, replies: true, intervalMinutes: 180, maxTurns: 10, confirm: true,
    modelFingerprint: 'preview', notificationThreadId: 'trusted-thread' }, owner());
  let source = { id: 'stop-message', threadId: 'trusted-thread', userId: 'owner', catId: null, content: '我来聊', timestamp: Date.now() + 1000,
    from: { kind: 'external' } };
  f.host.messaging.get = async () => source;
  const delivery = { kind: 'message', deliveryId: 'delivery', threadId: 'trusted-thread', envelope: { messageId: source.id } };
  await f.runtime.ownerDelivery(delivery);
  assert.equal((await f.runtime.status()).policies[0].mode, 'active');
  source = { ...source, from: { kind: 'user', userId: 'owner' } };
  await f.runtime.ownerDelivery(delivery);
  const paused = (await f.runtime.status()).policies[0];
  assert.equal(paused.mode, 'owner');
  await f.runtime.ownerDelivery(delivery);
  assert.equal((await f.runtime.status()).policies[0].epoch, paused.epoch);
});

test('local takeover acknowledgement does not wait for an unresponsive account status endpoint', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  f.client.identity = () => new Promise(() => {});
  const result = await Promise.race([f.runtime.dispatch({ action: 'pause_all' }, owner()), new Promise(resolve => setTimeout(() => resolve(null), 50))]);
  assert.notEqual(result, null);
  assert.equal(result.globalPause, true);
});

test('Host teardown persists stop before revocation, then releases local resources without using revoked storage', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  await f.runtime.dispatch({ action: 'pause_all' }, owner());
  // The real Host calls preStop while its ports are current, then revokes them
  // before stop. A second durable takeover during stop must not call the Host.
  await f.runtime.preStop();
  assert.equal((await f.host.storage.get('wechat-delegation.v1')).value.globalPause, true);
  let revokedAccesses = 0;
  f.host.storage.get = async () => { revokedAccesses++; throw Error('Host activation revoked'); };
  f.host.storage.compareAndSet = async () => { revokedAccesses++; throw Error('Host activation revoked'); };
  await f.runtime.stop();
  assert.equal(f.runtime.supervisor.client, null);
  assert.equal(revokedAccesses, 0);
});

test('failed-start cleanup can stop owned resources after Host ports have already been revoked', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  f.host.storage.get = async () => { throw Error('Host activation revoked'); };
  await f.runtime.stop();
  assert.equal(f.runtime.supervisor.client, null);
  assert.equal(f.runtime.running, false);
});

test('global takeover also cancels an authorization still waiting for model preparation, including a new conversation', async t => {
  const f = await fixture(t);
  const revoked=[]; f.host.memberSessions={revoke:async id=>{revoked.push(id);}};
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  let release, entered;
  const prepared = new Promise(resolve => { release = resolve; });
  const preparing = new Promise(resolve => { entered = resolve; });
  f.runtime.model.prepare = async () => { entered(); return prepared; };
  const activation = f.runtime.dispatch({ action: 'activate', accountIdentity: 'wxid_owner', serverId: 'server', target: { id: 'room@chatroom', kind: 'group' }, catId: 'cat', persona: '自然',
    goal: '读书', proactive: true, replies: true, intervalMinutes: 180, maxTurns: 10, confirm: true, modelFingerprint: 'preview' }, owner());
  await preparing;
  await f.runtime.dispatch({ action: 'pause_all' }, owner());
  release({ sessionId: 'late', generation: 1, threadId: 'isolated', consumedCursor: 0 });
  await assert.rejects(activation, /接管|变化|changed/);
  assert.equal((await f.runtime.status()).policies.length, 0);
  assert.deepEqual(revoked,['late']);
});

test('a busy conversation retains incoming work without blocking the account cursor or another conversation', async t => {
  const f=await fixture(t); await f.runtime.dispatch({action:'prepare',acceptThirdParty:true},owner());
  f.client.targets=async()=>({items:[{id:'room@chatroom',accountId:'clowder',kind:'group'},{id:'friend',accountId:'clowder',kind:'direct'}]});
  for(const target of [{id:'room@chatroom',kind:'group'},{id:'friend',kind:'direct'}]) await f.runtime.dispatch({action:'activate',accountIdentity:'wxid_owner',serverId:'server',target,catId:'cat',persona:'友好',goal:'读书',proactive:true,replies:true,intervalMinutes:180,maxTurns:10,confirm:true,modelFingerprint:'preview'},owner());
  f.client.submit=async run=>{f.sends.push(run);return{sendId:run.id,state:'queued'};};
  let settled=false; f.client.inspect=async run=>({sendId:run.id,state:settled?'accepted':'queued'});
  const group=(await f.runtime.service.snapshot()).policies.find(p=>p.kind==='group');
  await f.runtime.service.initiate(group.id,'busy');
  const createdAt=new Date(Date.now()+1000).toISOString();
  f.client.events=async(_account,cursor)=>({items:cursor==='0'?['room@chatroom','friend'].map((threadId,index)=>({cursor:String(index+1),kind:'message.committed',createdAt,data:{threadId,messageId:`message-${index}`}})):[]});
  f.client.message=async(_account,id)=>({id,accountId:'clowder',threadId:id==='message-0'?'room@chatroom':'friend',direction:'incoming',body:'周末读书',createdAt});
  await f.runtime.cycle(); await f.runtime.drain();
  let state=await f.runtime.service.snapshot(); assert.equal(state.cursors.clowder,'2');
  assert.equal(f.sends.filter(run=>run.conversationId==='friend').length,1);
  assert.equal(state.runs.filter(run=>run.phase==='waiting').length,1);
  settled=true; await f.runtime.cycle(); await f.runtime.drain();
  state=await f.runtime.service.snapshot(); assert.equal(state.runs.filter(run=>run.phase==='waiting').length,0);
  assert.equal(f.sends.filter(run=>run.conversationId==='room@chatroom').length,2);
});

test('an owner or subscription failure after member preparation revokes the uncommitted session', async t => {
  const f=await fixture(t); await f.runtime.dispatch({action:'prepare',acceptThirdParty:true},owner());
  const revoked=[];f.host.memberSessions={revoke:async id=>{revoked.push(id);}};
  f.host.messaging.subscribe=async()=>{throw Error('subscription unavailable');};
  await assert.rejects(f.runtime.dispatch({action:'activate',accountIdentity:'wxid_owner',serverId:'server',target:{id:'room@chatroom',kind:'group'},catId:'cat',persona:'友好',goal:'读书',proactive:true,replies:true,intervalMinutes:180,maxTurns:10,confirm:true,modelFingerprint:'preview',notificationThreadId:'owner-thread'},owner()),/subscription/);
  assert.deepEqual(revoked,['s']); assert.equal((await f.runtime.service.snapshot()).policies.length,0);
});

test('takeover during an event-page request prevents subsequent message-body reads and model work', async t => {
  const f=await fixture(t); await f.runtime.dispatch({action:'prepare',acceptThirdParty:true},owner());
  await f.runtime.dispatch({action:'activate',accountIdentity:'wxid_owner',serverId:'server',target:{id:'room@chatroom',kind:'group'},catId:'cat',persona:'友好',goal:'读书',proactive:true,replies:true,intervalMinutes:180,maxTurns:10,confirm:true,modelFingerprint:'preview'},owner());
  let entered,release;const requested=new Promise(resolve=>{entered=resolve;}),page=new Promise(resolve=>{release=resolve;});
  f.client.events=async()=>{entered();return page;};let reads=0;f.client.message=async()=>{reads++;throw Error('body read after takeover');};
  const cycle=f.runtime.cycle();await requested;
  await f.runtime.dispatch({action:'pause_all'},owner());
  release({items:[{cursor:'1',kind:'message.committed',createdAt:new Date(Date.now()+1000).toISOString(),data:{threadId:'room@chatroom',messageId:'after-stop'}}]});
  await cycle;await f.runtime.drain();assert.equal(reads,0);assert.equal(f.sends.length,0);
});

test('older audit records remain reachable through bounded history pages after the live view fills', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  await f.runtime.dispatch({ action: 'activate', accountIdentity: 'wxid_owner', serverId: 'server', target: { id: 'room@chatroom', kind: 'group' }, catId: 'cat', persona: '自然',
    goal: '读书', proactive: false, replies: true, intervalMinutes: 180, maxTurns: 200, confirm: true, modelFingerprint: 'preview' }, owner());
  f.client.submit = async run => ({ sendId: run.id, state: 'accepted' });
  for (let n = 0; n < 105; n++) await f.runtime.service.incoming('clowder', { id: `history-${n}`, threadId: 'room@chatroom', direction: 'incoming', body: '聊读书', createdAt: Date.now() + 1000 });
  const seen = new Set(); let cursor;
  do {
    const page = await f.runtime.dispatch({ action: 'history', ...(cursor === undefined ? {} : { cursor }) }, owner());
    assert.ok(page.items.length <= 50);
    for (const run of page.items) seen.add(run.id);
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(seen.size, 105);
});

test('the UI receives an initiative acknowledgement only after its durable run record exists', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  await f.runtime.dispatch({ action: 'activate', accountIdentity: 'wxid_owner', serverId: 'server', target: { id: 'room@chatroom', kind: 'group' }, catId: 'cat', persona: '自然',
    goal: '读书', proactive: true, replies: true, intervalMinutes: 180, maxTurns: 10, confirm: true, modelFingerprint: 'preview' }, owner());
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), writing = new Promise(resolve => { entered = resolve; });
  const original = f.host.storage.compareAndSet;
  let delayed = false;
  f.host.storage.compareAndSet = async (key, revision, value) => {
    if (!delayed && value.runs && Object.keys(value.runs).length) { delayed = true; entered(); await gate; }
    return original(key, revision, value);
  };
  const operation = f.runtime.dispatch({ action: 'initiate', policyId: (await f.runtime.status()).policies[0].id, operationId: 'durable-request' }, owner());
  await writing;
  const acknowledgedEarly = await Promise.race([operation.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 20))]);
  release(); await operation; await f.runtime.drain();
  assert.equal(acknowledgedEarly, false);
  assert.equal((await f.runtime.status()).runs.length, 1);
});

test('native process loss and re-preparation never silently resume existing conversation grants', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  await f.runtime.dispatch({ action: 'activate', accountIdentity: 'wxid_owner', serverId: 'server', target: { id: 'room@chatroom', kind: 'group' }, catId: 'cat', persona: '自然',
    goal: '读书', proactive: true, replies: true, intervalMinutes: 180, maxTurns: 10, confirm: true, modelFingerprint: 'preview' }, owner());
  f.runtime.supervisor.client = null;
  f.runtime.supervisor.onExit?.();
  await f.runtime.drain();
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  assert.equal((await f.runtime.status()).policies[0].mode, 'owner');
  assert.equal(f.sends.length, 0);
});

test('directory verification remains asynchronous, does not block owner status and cannot authorize a pending recipient', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  let resets = 0;
  f.client.directoryPending = () => true;
  f.client.refreshTargets = () => { resets++; };
  f.client.identity = async () => { throw Error('metadata lock must not block status'); };
  f.client.targets = async () => ({ items: [], pending: true });
  const state = await f.runtime.dispatch({ action: 'status' }, owner());
  assert.equal(state.account.connected, true);
  assert.equal(state.accountIsLive, false);
  const pending = await f.runtime.dispatch({ action: 'chats', refreshDirectory: true }, owner());
  assert.equal(pending.pending, true);
  assert.equal(resets, 1);
  await assert.rejects(f.runtime.dispatch({ action: 'chats', refreshDirectory: true, cursor: 'old' }, owner()), /第一页/);
  f.client.identity = async () => ({ serverId: 'server', accountId: 'clowder', accountIdentity: 'wxid_owner', nativeStoreId: 'synthetic-store', accountGeneration: 1, connected: true });
  await assert.rejects(f.runtime.dispatch({ action: 'activate', accountIdentity: 'wxid_owner', serverId: 'server', target: { id: 'room@chatroom', kind: 'group' }, catId: 'cat', confirm: true }, owner()), /正在核对/);
  assert.equal((await f.runtime.status()).policies.length, 0);
  assert.equal(f.sends.length, 0);
});

test('a transient identity probe failure preserves the last verified account without reporting it as a live check', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  const verified = await f.runtime.status();
  f.client.identity = async () => { throw Error('temporary metadata lock timeout'); };
  const uncertain = await f.runtime.status();
  assert.equal(uncertain.account.accountIdentity, verified.account.accountIdentity);
  assert.equal(uncertain.account.connected, true);
  assert.equal(uncertain.accountIsLive, false);
  assert.equal(uncertain.accountProbeFailed, true);
  assert.equal(uncertain.accountObservedAt, verified.accountObservedAt);
});


test('activation refuses an account change hidden behind a failed status probe', async t => {
  const f = await fixture(t);
  await f.runtime.dispatch({ action: 'prepare', acceptThirdParty: true }, owner());
  f.client.identity = async () => ({ serverId: 'replacement-server', accountId: 'clowder', accountIdentity: 'other-owner', connected: true });
  await assert.rejects(f.runtime.dispatch({ action: 'activate', accountIdentity: 'wxid_owner', serverId: 'server', target: { id: 'room@chatroom', kind: 'group' }, catId: 'cat', persona: '自然友好', goal: '读书', proactive: true, replies: true, confirm: true, modelFingerprint: 'preview', intervalMinutes: 180, maxTurns: 10 }, owner()), /账号.*变化/);
  assert.equal((await f.runtime.status()).policies.length, 0);
  assert.equal(f.sends.length, 0);
});

test('an owner stop returns locally before native pause ACK; explicit restore waits for pause and old model revocation',async t=>{
  const f=await fixture(t);await f.runtime.dispatch({action:'prepare',acceptThirdParty:true},owner());
  let generation=0;const grants=[];f.client.authorize=async()=>{grants.push(++generation);return{accountGeneration:1,conversationGeneration:generation,destination:'room@chatroom'};};
  f.client.pause=async()=>({paused:true});
  const input={action:'activate',accountIdentity:'wxid_owner',serverId:'server',target:{id:'room@chatroom',kind:'group'},catId:'cat',persona:'自然',goal:'读书',proactive:true,replies:true,intervalMinutes:180,maxTurns:10,confirm:true,modelFingerprint:'preview'};
  await f.runtime.dispatch(input,owner());assert.equal(grants.length,1);
  const id=(await f.runtime.service.snapshot()).policies[0].id;
  let pauseDone,revokeDone;const pause=new Promise(r=>pauseDone=r),revoke=new Promise(r=>revokeDone=r);let revocations=0;
  f.client.pause=()=>pause;f.host.memberSessions={revoke:()=>{revocations++;return revoke;}};
  await f.runtime.dispatch({action:'takeover',policyId:id},owner());
  assert.equal((await f.runtime.service.snapshot()).policies[0].mode,'owner');assert.equal(revocations,1);
  const epoch=(await f.runtime.service.snapshot()).policies[0].epoch;
  const restoring=f.runtime.dispatch({...input,expectedEpoch:epoch},owner());
  await new Promise(r=>setImmediate(r));assert.equal(grants.length,1);
  pauseDone({paused:true});await new Promise(r=>setImmediate(r));assert.equal(grants.length,1);
  revokeDone({revoked:true});await restoring;assert.equal(grants.length,2);
});

test('two same-epoch activations cannot grant twice or revoke a winning session; takeover during grant rejects late activation',async t=>{
  const f=await fixture(t);await f.runtime.dispatch({action:'prepare',acceptThirdParty:true},owner());
  let enter,finish;const entered=new Promise(r=>enter=r),grant=new Promise(r=>finish=r);let grants=0;
  f.client.authorize=async()=>{grants++;enter();return grant;};f.client.pause=async()=>({paused:true});
  const input={action:'activate',accountIdentity:'wxid_owner',serverId:'server',target:{id:'room@chatroom',kind:'group'},catId:'cat',persona:'自然',goal:'读书',proactive:true,replies:true,intervalMinutes:180,maxTurns:10,confirm:true,modelFingerprint:'preview'};
  const first=f.runtime.dispatch(input,owner());await entered;
  const second=f.runtime.dispatch(input,owner());
  await f.runtime.dispatch({action:'pause_all'},owner());
  finish({accountGeneration:1,conversationGeneration:1,destination:'room@chatroom'});
  const results=await Promise.allSettled([first,second]);
  assert.equal(results.every(r=>r.status==='rejected'),true);assert.equal(grants,1);
  assert.equal((await f.runtime.service.snapshot()).policies.filter(p=>p.mode==='active').length,0);
});

test('two concurrent confirmed starts yield one grant and no cleanup against the winner',async t=>{
  const f=await fixture(t);await f.runtime.dispatch({action:'prepare',acceptThirdParty:true},owner());
  let enter,finish;const entered=new Promise(r=>enter=r),grant=new Promise(r=>finish=r);let grants=0;const revoked=[];
  f.client.authorize=async()=>{grants++;enter();return grant;};f.host.memberSessions={revoke:async id=>revoked.push(id)};
  const input={action:'activate',accountIdentity:'wxid_owner',serverId:'server',target:{id:'room@chatroom',kind:'group'},catId:'cat',persona:'自然',goal:'读书',proactive:true,replies:true,intervalMinutes:180,maxTurns:10,confirm:true,modelFingerprint:'preview'};
  const first=f.runtime.dispatch(input,owner());await entered;const second=f.runtime.dispatch(input,owner());await new Promise(r=>setImmediate(r));
  finish({accountGeneration:1,conversationGeneration:1,destination:'room@chatroom'});
  const results=await Promise.allSettled([first,second]);assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.equal(grants,1);assert.deepEqual(revoked,[]);
});

test('an implicit model handoff pauses the native sender without invoking owner-only member revocation',async t=>{
  const f=await fixture(t);await f.runtime.dispatch({action:'prepare',acceptThirdParty:true},owner());
  const input={action:'activate',accountIdentity:'wxid_owner',serverId:'server',target:{id:'room@chatroom',kind:'group'},catId:'cat',persona:'自然',goal:'读书',proactive:true,replies:true,intervalMinutes:180,maxTurns:10,confirm:true,modelFingerprint:'preview'};
  await f.runtime.dispatch(input,owner());let pauses=0,revokes=0;f.client.pause=async()=>{pauses++;return{paused:true};};f.host.memberSessions={revoke:async()=>{revokes++;}};
  f.runtime.model.generate=async()=>({kind:'silent',text:''});const policy=(await f.runtime.service.snapshot()).policies[0];
  await f.runtime.dispatch({action:'initiate',policyId:policy.id,operationId:'silent'},owner());await f.runtime.drain();
  assert.equal(pauses,1);assert.equal(revokes,0);assert.equal((await f.runtime.service.snapshot()).policies[0].mode,'paused');
});

test('teardown releases local resources while a model port is unresolved and late completion cannot access revoked Host storage',async t=>{
  const f=await fixture(t);await f.runtime.dispatch({action:'prepare',acceptThirdParty:true},owner());
  await f.runtime.dispatch({action:'activate',accountIdentity:'wxid_owner',serverId:'server',target:{id:'room@chatroom',kind:'group'},catId:'cat',persona:'自然',goal:'读书',proactive:true,replies:true,intervalMinutes:180,maxTurns:10,confirm:true,modelFingerprint:'preview'},owner());
  let enter,finish;const entered=new Promise(r=>enter=r),model=new Promise(r=>finish=r);f.runtime.model.generate=async()=>{enter();return model;};
  const policy=(await f.runtime.service.snapshot()).policies[0];await f.runtime.dispatch({action:'initiate',policyId:policy.id,operationId:'shutdown'},owner());await entered;
  const stopping=f.runtime.preStop();const released=await Promise.race([stopping.then(()=>true),new Promise(r=>setImmediate(()=>r(false)))]);
  let revokedAccess=0;f.host.storage.get=async()=>{revokedAccess++;throw Error('revoked');};f.host.storage.compareAndSet=f.host.storage.get;
  finish({kind:'message',text:'late'});await stopping;await f.runtime.drain();
  assert.equal(released,true);assert.equal(revokedAccess,0);assert.equal(f.sends.length,0);
});

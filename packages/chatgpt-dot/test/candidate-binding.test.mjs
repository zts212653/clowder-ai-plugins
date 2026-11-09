import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createDotPlugin } from "../src/plugin-entrypoint.ts";
import { DotConnection } from "../src/connection.ts";
import { DotRuntime } from "../src/runtime.ts";
import { rpc } from "../src/rpc.ts";
import { digest } from "../src/store.ts";
import { CONNECTION_KEY, EXTERNAL_KEY } from "../src/store.ts";
import { paired, mcp, delivery } from "./fixture.mjs";

const secret = "whsec_" + Buffer.alloc(32, 7).toString("base64");
const newUrl = "https://callbacks.example/candidate";
async function candidateFixture(t, expired = false) {
  const f = await paired(t);
  await f.active.stop({reason:"test"});
  if (expired) {
    const old = f.records.get(CONNECTION_KEY).value;
    await f.host.storage.set(CONNECTION_KEY,{...old,subscription:{...old.subscription,expiresAt:Date.now()-1}});
  }
  f.old = structuredClone(f.records.get(CONNECTION_KEY).value.subscription);
  let sequence=0;
  f.host.capability = { inspectExternal: async()=>({usable:true,reason:"usable",refreshRecommended:false}), issueExternal: async()=>{
    const n=++sequence;
    return {token:`token-${n}`,tokenId:`jti-${n}`,issuedAt:1,expiresAt:2_000_000_000,refreshRecommendedAt:1_900_000_000};
  }};
  f.module=createDotPlugin({sendWebhook:async(url,headers,body,signal,beforeWrite)=>{
    const override=await f.webhookHook?.(url,JSON.parse(body));
    await beforeWrite?.();
    return override ?? f.sendWebhook(url,headers,body,signal);
  }});
  f.settings=await f.module.settings(f.host);
  f.active=await f.module.start(f.host);
  f.dot=new DotConnection(f.host,f.sendWebhook,new AbortController().signal);
  f.rpc=(method,params,jti=f.jti)=>mcp(f.active,{request:{method:"POST",headers:{},...(jti?{credential:{sub:f.host.pluginInstanceId,cap:"dot-mcp",jti,iat:1,exp:2_000_000_000}}:{}),body:{jsonrpc:"2.0",id:1,method,params}}});
  f.tool=(name,args,jti=f.jti)=>f.rpc("tools/call",{name,arguments:args},jti);
  f.begin=async()=>{
    const {state}=await f.dot.issuePending(f.owner,3600);
    f.jti=state.pending.tokenId;
    await f.dot.setLongLivedServerUrl(`https://new.example/mcp?token=${state.pending.token}`);
    assert.equal((await f.rpc("server/discover",{})).body.error,undefined);
    const message=await f.settings.actions["dot.show-instructions"]({},undefined,f.owner);
    f.code=message.data.match(/pairing_code=([a-f0-9]+)/)[1];
  };
  f.subscribe=()=>f.rpc("events/subscribe",{name:"dot.summoned",arguments:{attempt_id:f.records.get(CONNECTION_KEY).value.attemptId,pairing_code:f.code},delivery:{mode:"webhook",url:newUrl,secret},ttlMs:null});
  f.startProof=async()=>{
    await f.settings.actions["dot.roundtrip"]({},undefined,f.owner);
    return f.records.get(EXTERNAL_KEY).value.pending.verificationEventId;
  };
  f.finish=async(id)=>{
    assert.equal((await f.tool("cat_cafe_dot_read_source",{event_id:id})).body.error,undefined);
    const record=f.records.get(`dot/dispatch/${id}`).value;
    return f.tool("cat_cafe_dot_reply",{event_id:id,content:`ok ${record.expectedNonce}`});
  };
  await f.begin();
  return f;
}

for(const expired of [false,true]) test(`candidate binds and proves independently of old subscription (expired=${expired})`,async t=>{
  const f=await candidateFixture(t,expired);
  assert.equal((await f.subscribe()).body.error,undefined);
  assert.deepEqual((await f.dot.current()).subscription,f.old);
  if(!expired){
    await f.active.deliver(delivery(f));
    const ordinary=f.webhooks.filter(w=>w.data.name==="dot.summoned").at(-1);
    assert.equal(ordinary.url,f.old.url);
    assert.ok((await f.tool("cat_cafe_dot_read_source",{event_id:ordinary.data.eventId})).body.error);
  }
  const id=await f.startProof();
  assert.equal(f.webhooks.filter(w=>w.data.eventId===id).at(-1).url,newUrl);
  assert.ok((await f.tool("cat_cafe_dot_read_source",{event_id:id},null)).body.error);
  assert.equal((await f.finish(id)).body.error,undefined);
  assert.equal((await f.dot.current()).subscription.url,newUrl);
  const stableAttempt=f.records.get(CONNECTION_KEY).value.attemptId;
  const raw=f.records.get(CONNECTION_KEY).value;
  await f.host.storage.set(CONNECTION_KEY,{...raw,pairingExpiresAt:1});
  const repeated=await f.settings.actions["dot.show-instructions"]({},undefined,f.owner);
  assert.equal(f.records.get(CONNECTION_KEY).value.attemptId,stableAttempt);
  assert.ok(repeated.data.includes(f.code));
  assert.equal(f.records.get(EXTERNAL_KEY).value.pending,null);
  await f.active.deliver(delivery(f,"after-promotion"));
  assert.equal(f.webhooks.filter(w=>w.data.name==="dot.summoned").at(-1).url,newUrl);
});

test("callback challenge failure and cancellation never overwrite the established binding",async t=>{
  const f=await candidateFixture(t);
  f.webhookHook=()=>({status:200,body:'{"challenge":"wrong"}'});
  assert.ok((await f.subscribe()).body.error);
  assert.deepEqual((await f.dot.current()).subscription,f.old);
  let release,entered;
  const started=new Promise(r=>entered=r), gate=new Promise(r=>release=r);
  f.webhookHook=async()=>{entered();await gate;};
  const request=f.subscribe();await started;
  await f.dot.cancelPending();release();
  assert.ok((await request).body.error);
  assert.deepEqual((await f.dot.current()).subscription,f.old);
  assert.equal(f.records.get(EXTERNAL_KEY).value.pending,null);
});

for(const action of ["cancel","replace","disconnect"]) test(`${action} during source read rejects late candidate proof`,async t=>{
  const f=await candidateFixture(t);
  assert.equal((await f.subscribe()).body.error,undefined);
  const id=await f.startProof();
  const read=f.host.threads.readMessages;
  f.host.threads.readMessages=async(...args)=>{
    if(action==="cancel")await f.dot.cancelPending();
    if(action==="replace")await f.dot.issuePending(f.owner,3600);
    if(action==="disconnect"){await f.dot.revokeExternal();await f.dot.disconnect(f.owner);}
    return read(...args);
  };
  assert.ok((await f.tool("cat_cafe_dot_read_source",{event_id:id})).body.error);
  assert.equal(f.records.get(`dot/dispatch/${id}`).value.sourceReadAt,null);
  if(action!=="disconnect")assert.deepEqual((await f.dot.current()).subscription,f.old);
  else assert.equal(f.records.get(EXTERNAL_KEY).value.current,null);
});

test("saved reply resumes candidate promotion after restart without sending twice, then unsubscribe stays revoked",async t=>{
  const f=await candidateFixture(t,true);
  assert.equal((await f.subscribe()).body.error,undefined);
  const id=await f.startProof();
  assert.equal((await f.tool("cat_cafe_dot_read_source",{event_id:id})).body.error,undefined);
  const cas=f.host.storage.compareAndSet.bind(f.host.storage);
  let fail=true;
  f.host.storage.compareAndSet=async(key,revision,value)=>{
    if(fail && key===EXTERNAL_KEY && value.pending?.verificationReplyAt!==null){fail=false;throw new Error("simulated proof write interruption");}
    return cas(key,revision,value);
  };
  const nonce=f.records.get(`dot/dispatch/${id}`).value.expectedNonce;
  const reply=()=>f.tool("cat_cafe_dot_reply",{event_id:id,content:`ok ${nonce}`});
  assert.ok((await reply()).body.error);
  assert.ok(f.records.get(`dot/dispatch/${id}`).value.replyMessageId);
  const sent=f.sent.length;
  await f.active.stop({reason:"test-restart"});f.active=await f.module.start(f.host);
  assert.equal((await reply()).body.error,undefined);
  assert.equal(f.sent.length,sent);
  assert.equal((await f.dot.current()).subscription.url,newUrl);
  assert.equal(f.records.get(EXTERNAL_KEY).value.pending,null);
  assert.equal((await f.rpc("events/unsubscribe",{name:"dot.summoned",arguments:{attempt_id:f.records.get(CONNECTION_KEY).value.attemptId,pairing_code:f.code},delivery:{mode:"webhook",url:newUrl}})).body.error,undefined);
  await f.active.stop({reason:"test-restart"});f.active=await f.module.start(f.host);
  assert.equal((await f.dot.current()).subscription,null);
  await assert.rejects(f.dot.ready(),/subscription_required/);
  assert.ok(f.records.get(CONNECTION_KEY).value.subscription,"legacy storage remains but is never resurrected");
  const renewed=await f.settings.actions["dot.show-instructions"]({},undefined,f.owner);
  f.code=renewed.data.match(/pairing_code=([a-f0-9]+)/)[1];
  assert.equal((await f.subscribe()).body.error,undefined,"owner can explicitly re-authorize the pinned current callback");
  assert.equal((await f.dot.current()).subscription.url,newUrl);
  await f.settings.actions["dot.reconnect"]({},undefined,f.owner);
  assert.equal(f.records.get(EXTERNAL_KEY).value.current,null);
  assert.equal((await f.dot.current()).subscription,null);
});

test("candidate subscription requires discovery and its owner message; replacing its callback invalidates old proof",async t=>{
  const f=await candidateFixture(t);
  const current=structuredClone((await f.dot.current()).subscription);
  await f.dot.issuePending(f.owner,3600);
  f.jti=f.records.get(EXTERNAL_KEY).value.pending.tokenId;
  await f.dot.setLongLivedServerUrl("https://new.example/mcp?token=new");
  assert.ok((await f.subscribe()).body.error);
  await f.rpc("server/discover",{});
  assert.ok((await f.subscribe()).body.error,"discovery is not owner pairing intent");
  const message=await f.settings.actions["dot.show-instructions"]({},undefined,f.owner);
  f.code=message.data.match(/pairing_code=([a-f0-9]+)/)[1];
  assert.equal((await f.subscribe()).body.error,undefined);
  const bindingVersion=f.records.get(EXTERNAL_KEY).value.pending.binding.version;
  assert.equal((await f.subscribe()).body.error,undefined);
  assert.equal(f.records.get(EXTERNAL_KEY).value.pending.binding.version,bindingVersion,"identical subscribe is idempotent");
  const id=await f.startProof();
  assert.equal((await f.rpc("events/subscribe",{name:"dot.summoned",arguments:{attempt_id:f.records.get(CONNECTION_KEY).value.attemptId,pairing_code:f.code},delivery:{mode:"webhook",url:"https://callbacks.example/changed",secret},ttlMs:null})).body.error,undefined);
  assert.ok((await f.tool("cat_cafe_dot_read_source",{event_id:id})).body.error);
  assert.deepEqual((await f.dot.current()).subscription,current);
  assert.ok((await f.rpc("events/unsubscribe",{name:"dot.summoned",arguments:{attempt_id:f.records.get(CONNECTION_KEY).value.attemptId,pairing_code:f.code},delivery:{mode:"webhook",url:newUrl}})).body.error);
});

test("current unsubscribe invalidates a staged candidate and reconnect retires late proof",async t=>{
  const f=await candidateFixture(t);
  assert.equal((await f.subscribe()).body.error,undefined);
  const id=await f.startProof();
  const legacy=f.records.get(CONNECTION_KEY).value;
  assert.equal((await f.rpc("events/unsubscribe",{name:"dot.summoned",arguments:{attempt_id:legacy.attemptId,pairing_code:legacy.pairingCode},delivery:{mode:"webhook",url:legacy.subscription.url}},null)).body.error,undefined);
  assert.equal(f.records.get(EXTERNAL_KEY).value.pending,null);
  assert.ok((await f.tool("cat_cafe_dot_read_source",{event_id:id})).body.error);
  assert.equal((await f.dot.current()).subscription,null);
});

test("renewed owner intent invalidates old verification even when the callback is unchanged",async t=>{
  const f=await candidateFixture(t);
  await f.subscribe();const id=await f.startProof();
  const external=f.records.get(EXTERNAL_KEY).value;
  await f.host.storage.set(EXTERNAL_KEY,{...external,pending:{...external.pending,pairingIntent:{...external.pending.pairingIntent,expiresAt:1}}});
  const message=await f.settings.actions["dot.show-instructions"]({},undefined,f.owner);
  const oldCode=f.code;f.code=message.data.match(/pairing_code=([a-f0-9]+)/)[1];
  assert.notEqual(f.code,oldCode);
  assert.ok((await f.tool("cat_cafe_dot_read_source",{event_id:id})).body.error);
  assert.equal((await f.subscribe()).body.error,undefined);
  assert.deepEqual((await f.dot.current()).subscription,f.old);
});

test("new-format current unsubscribe atomically retires its dependent candidate",async t=>{
  const f=await candidateFixture(t);
  await f.subscribe();assert.equal((await f.finish(await f.startProof())).body.error,undefined);
  const formal=await f.dot.current(),jti=f.jti;
  await f.begin();await f.subscribe();const id=await f.startProof();
  const candidateId=f.records.get(EXTERNAL_KEY).value.pending.candidateId;
  assert.equal((await f.rpc("events/subscribe",{name:"dot.summoned",arguments:{attempt_id:formal.attemptId,pairing_code:formal.pairingCode},delivery:{mode:"webhook",url:formal.subscription.url,secret},ttlMs:null},jti)).body.error,undefined);
  assert.equal(f.records.get(EXTERNAL_KEY).value.pending.candidateId,candidateId,"routine current renewal preserves an independent candidate");
  assert.equal((await f.rpc("events/unsubscribe",{name:"dot.summoned",arguments:{attempt_id:formal.attemptId,pairing_code:formal.pairingCode},delivery:{mode:"webhook",url:formal.subscription.url}},jti)).body.error,undefined);
  assert.equal(f.records.get(EXTERNAL_KEY).value.pending,null);
  assert.equal((await f.dot.current()).subscription,null);
  assert.ok((await f.tool("cat_cafe_dot_read_source",{event_id:id})).body.error);
});

test("owner instruction generation upgrades an existing legacy pending record into controlled candidate pairing",async t=>{
  const f=await candidateFixture(t);
  const value=f.records.get(EXTERNAL_KEY).value;
  const {binding:_binding,pairingIntent:_intent,...legacy}=value.pending;
  await f.host.storage.set(EXTERNAL_KEY,{...value,pending:legacy});
  assert.ok((await f.subscribe()).body.error,"legacy replacement cannot gain callback authority without the owner step");
  const message=await f.settings.actions["dot.show-instructions"]({},undefined,f.owner);
  f.code=message.data.match(/pairing_code=([a-f0-9]+)/)[1];
  assert.equal(f.records.get(EXTERNAL_KEY).value.pending.binding,null);
  assert.equal((await f.subscribe()).body.error,undefined);
  assert.equal((await f.finish(await f.startProof())).body.error,undefined);
  assert.equal((await f.dot.current()).subscription.url,newUrl);
});

for (const reauthorize of [false, true]) test(`late current renewal cannot overwrite unsubscribe or owner reauthorization (reauthorize=${reauthorize})`, async t => {
  const f = await candidateFixture(t);
  await f.subscribe();
  assert.equal((await f.finish(await f.startProof())).body.error, undefined);
  const formal = await f.dot.current();
  const credential = {sub:f.host.pluginInstanceId,cap:"dot-mcp",jti:f.jti,iat:1,exp:2_000_000_000};
  const lateSecret = "whsec_" + Buffer.alloc(32, 8).toString("base64");
  const authorizedSecret = "whsec_" + Buffer.alloc(32, 9).toString("base64");
  const authorize = f.dot.authorizeExternal.bind(f.dot);
  const send = f.dot.send;
  let challenged = false, interleaved = false, authoritative;
  f.dot.send = async (...args) => {
    const response = await send(...args);
    challenged = true;
    return response;
  };
  // Interleave after the renewal's final authorization succeeds, before its commit.
  f.dot.authorizeExternal = async (value, operation, eventId) => {
    const result = await authorize(value, operation, eventId);
    if (challenged && !interleaved && operation === "pairing-subscribe") {
      interleaved = true;
      await f.dot.unsubscribe({attemptId:formal.attemptId,pairingCode:formal.pairingCode,url:formal.subscription.url}, credential);
      assert.equal((await f.dot.current()).subscription, null);
      if (reauthorize) {
        const message = await f.settings.actions["dot.show-instructions"]({}, undefined, f.owner);
        const pairingCode = message.data.match(/pairing_code=([a-f0-9]+)/)[1];
        assert.notEqual(pairingCode, formal.pairingCode);
        const response = await f.rpc("events/subscribe", {name:"dot.summoned",arguments:{attempt_id:formal.attemptId,pairing_code:pairingCode},delivery:{mode:"webhook",url:formal.subscription.url,secret:authorizedSecret},ttlMs:null});
        assert.equal(response.body.error, undefined);
      }
      authoritative = structuredClone(f.records.get(EXTERNAL_KEY));
    }
    return result;
  };
  let failure;
  try {
    await f.dot.subscribe({attemptId:formal.attemptId,pairingCode:formal.pairingCode,url:formal.subscription.url,secret:lateSecret,ttlMs:null}, credential);
  } catch (error) { failure = error; }
  assert.equal(interleaved, true);
  assert.deepEqual(f.records.get(EXTERNAL_KEY), authoritative, "late renewal must not write after a newer authority decision");
  assert.match(failure?.message ?? "", /dot_binding_stale/);
  const current = await f.dot.current();
  assert.equal(current.subscription?.secret ?? null, reauthorize ? authorizedSecret : null);
});


for (const operation of ["reply", "publish-image", "ask"]) test(`queued ${operation} cannot borrow a promoted replacement credential`, async t => {
  const f = await candidateFixture(t);
  if (operation === "ask") f.host.messaging.subscribe = async ({threadId}) => assert.equal(threadId, "thread-1");
  await f.subscribe(); assert.equal((await f.finish(await f.startProof())).body.error, undefined);
  const tokenId = f.jti, formal = await f.dot.current();
  await f.active.deliver(delivery(f, `queued-${operation}`));
  const id = f.webhooks.filter(w => w.data.name === "dot.summoned").at(-1).data.eventId;
  const credential = {sub:f.host.pluginInstanceId,cap:"dot-mcp",jti:tokenId,iat:1,exp:2_000_000_000};
  const runtime = new DotRuntime(f.host, f.dot);
  await runtime.read(id, credential);
  await f.begin(); await f.subscribe(); const proof = await f.startProof();
  let entered, release, admitted;
  const started = new Promise(r => entered = r), gate = new Promise(r => release = r);
  const authorized = new Promise(r => admitted = r);
  const key = operation === "ask" ? `dot/ask/${digest([formal.attemptId, "queued-ask"])}` : id;
  const occupied = runtime.serial(key, async () => {entered(); await gate;});
  await started;
  const authorize = f.dot.authorizeExternal.bind(f.dot);
  f.dot.authorizeExternal = async (...args) => {const result = await authorize(...args); if(args[1] === operation) admitted(); return result;};
  const names = {reply:"cat_cafe_dot_reply", "publish-image":"cat_cafe_dot_publish_image", ask:"cat_cafe_dot_ask"};
  const args = operation === "reply" ? {event_id:id,content:"retired client reply"} : operation === "ask"
    ? {attempt_id:formal.attemptId,thread_id:"thread-1",client_message_id:"queued-ask",target_cat_ids:["cat-1"],content:"queued request"}
    : {event_id:id,publication_key:"queued-image",png_base64:(await sharp({create:{width:1,height:1,channels:4,background:"#336699"}}).png().toBuffer()).toString("base64")};
  const pending = rpc(runtime, {method:"POST",headers:{},credential,body:{jsonrpc:"2.0",id:1,method:"tools/call",params:{name:names[operation],arguments:args}}});
  await authorized;
  try {assert.equal((await f.finish(proof)).body.error, undefined);} finally {release();}
  const sent = f.sent.length;
  const result = await pending; await occupied;
  assert.match(result.body.error?.data?.reason ?? "", /dot_external_credential_rejected/, "old queued caller must be rejected before doing work");
  assert.equal(f.sent.length, sent, "revoked caller must not publish any Host message or completion");
  const fresh = await rpc(runtime, {method:"POST",headers:{},credential:{...credential,jti:f.jti},body:{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:names[operation],arguments:args}}});
  assert.equal(fresh.body.error, undefined, "the replacement credential can publish the same valid input");
  assert.equal(f.sent.length, sent + 1);
});

test("formal unsubscribe restores its saved endpoint instead of advertising a revoked candidate URL", async t => {
  const f = await candidateFixture(t);
  await f.subscribe(); await f.finish(await f.startProof());
  const formal = await f.dot.current(), jti = f.jti;
  const formalUrl = await f.dot.serverUrl();
  await f.begin(); await f.subscribe();
  assert.notEqual(await f.dot.serverUrl(), formalUrl);
  assert.equal((await f.rpc("events/unsubscribe", {name:"dot.summoned",arguments:{attempt_id:formal.attemptId,pairing_code:formal.pairingCode},delivery:{mode:"webhook",url:formal.subscription.url}}, jti)).body.error, undefined);
  assert.equal(await f.dot.serverUrl(), formalUrl);
  assert.equal(f.records.get(EXTERNAL_KEY).value.pending, null);
  assert.equal(f.records.get(EXTERNAL_KEY).value.current.tokenId, jti);
});

for (const window of ['current-read', 'external-cas']) test(`retired credential cannot unsubscribe its promoted replacement (${window})`, async t => {
  const f = await candidateFixture(t);
  await f.subscribe(); await f.finish(await f.startProof());
  const formal = await f.dot.current(), jti = f.jti;
  await f.begin(); await f.subscribe();
  await f.dot.store.updateExternal(state => ({...state,pending:{...state.pending,binding:{...state.pending.binding,pairingCode:formal.pairingCode}}}));
  const proof = await f.startProof();
  let release, entered;
  const gate = new Promise(r => release = r), reached = new Promise(r => entered = r);
  if (window === 'current-read') {
    const current = f.dot.current.bind(f.dot);
    f.dot.current = async () => { entered(); await gate; return current(); };
  } else {
    const update = f.dot.store.updateExternal.bind(f.dot.store);
    f.dot.store.updateExternal = async fn => { entered(); await gate; return update(fn); };
  }
  const credential = {sub:f.host.pluginInstanceId,cap:'dot-mcp',jti,iat:1,exp:2_000_000_000};
  const retiring = f.dot.unsubscribe({attemptId:formal.attemptId,pairingCode:formal.pairingCode,url:formal.subscription.url},credential);
  await reached;
  try { assert.equal((await f.finish(proof)).body.error,undefined); } finally { release(); }
  const saved = structuredClone(f.records.get(EXTERNAL_KEY));
  await assert.rejects(retiring, /dot_(external_credential_rejected|binding_stale)/);
  assert.deepEqual(f.records.get(EXTERNAL_KEY),saved);
  assert.equal((await f.dot.ready()).subscription.url,newUrl);
});

for (const mode of ['exited','expired']) test(`candidate with ${mode} temporary ingress cannot replace a working formal connection`, async t => {
  const f = await candidateFixture(t);
  await f.subscribe(); await f.finish(await f.startProof());
  const formal = structuredClone(f.records.get(EXTERNAL_KEY).value.current);
  await f.begin();
  const pending = f.records.get(EXTERNAL_KEY).value.pending;
  await f.dot.setTemporaryLease(pending.candidateId,{generation:'test-lease',serverUrl:'https://temporary.example/mcp',startedAt:Date.now(),expiresAt:Date.now()+60_000});
  await f.subscribe(); const proof = await f.startProof();
  assert.equal((await f.tool('cat_cafe_dot_read_source',{event_id:proof})).body.error,undefined);
  const record = f.records.get(`dot/dispatch/${proof}`).value;
  // End ingress after readiness/evidence reads but before the final promotion CAS.
  const update = f.dot.store.updateExternal.bind(f.dot.store);
  let ended = false;
  const ingress = new DotConnection(f.host,f.sendWebhook,new AbortController().signal);
  f.dot.store.updateExternal = async fn => {
    const state = await f.dot.store.external(), next = fn(state);
    if (!ended && state?.pending && !next.pending && next.current?.tokenId === pending.tokenId) {
      ended = true;
      if (mode === 'exited') await ingress.expireTemporary('test-lease');
      else await ingress.store.updateExternal(value => ({...value,endpoint:{...value.endpoint,expiresAt:Date.now()-1}}));
    }
    return update(fn);
  };
  const credential = {sub:f.host.pluginInstanceId,cap:'dot-mcp',jti:f.jti,iat:1,exp:2_000_000_000};
  await assert.rejects(f.dot.recordPendingEvidence(credential,proof,'reply'),/dot_(endpoint_unavailable|candidate_stale)/);
  assert.equal(ended,true);
  assert.deepEqual(f.records.get(EXTERNAL_KEY).value.current,formal);
  assert.ok(f.records.get(EXTERNAL_KEY).value.pending);
  assert.equal((await f.dot.ready()).subscription.url,formal.binding.subscription.url);
});

for (const mode of ['exited','expired']) test(`ended candidate ingress rejects reply before Host publication (${mode})`, async t => {
  const f = await candidateFixture(t);
  await f.subscribe(); await f.finish(await f.startProof());
  const formal = structuredClone(f.records.get(EXTERNAL_KEY).value.current);
  await f.begin();
  const pending = f.records.get(EXTERNAL_KEY).value.pending;
  await f.dot.setTemporaryLease(pending.candidateId,{generation:'ended-lease',serverUrl:'https://temporary.example/mcp',startedAt:Date.now(),expiresAt:Date.now()+60_000});
  await f.subscribe(); const proof = await f.startProof();
  assert.equal((await f.tool('cat_cafe_dot_read_source',{event_id:proof})).body.error,undefined);
  if (mode === 'exited') await f.dot.expireTemporary('ended-lease');
  else await f.dot.store.updateExternal(state => ({...state,endpoint:{...state.endpoint,expiresAt:Date.now()-1}}));
  const sent = f.sent.length;
  const nonce = f.records.get(`dot/dispatch/${proof}`).value.expectedNonce;
  assert.match((await f.tool('cat_cafe_dot_reply',{event_id:proof,content:`ok ${nonce}`})).body.error?.data?.reason ?? '',/dot_endpoint_unavailable/);
  assert.equal(f.sent.length,sent);
  assert.deepEqual(f.records.get(EXTERNAL_KEY).value.current,formal);
  assert.equal((await f.dot.ready()).subscription.url,formal.binding.subscription.url);
});

// An opaque legacy caller has no credential object; that is still an authority lane.
test('legacy subscribe admitted before promotion cannot renew the replacement binding', async t => {
  const f = await candidateFixture(t);
  const identity = f.records.get(CONNECTION_KEY).value;
  await f.host.storage.set(CONNECTION_KEY,{...identity,pairedAt:null,subscription:null,pairedCallbackUrl:null,pairingCode:f.code});
  await f.subscribe(); const proof = await f.startProof();
  const runtime = new DotRuntime(f.host,f.dot), authorize = f.dot.authorizeExternal.bind(f.dot);
  let admitted = false, protectedState;
  f.dot.authorizeExternal = async (...args) => {
    const result = await authorize(...args);
    if (!admitted && args[0] === undefined && args[1] === 'pairing-subscribe') {
      admitted = true;
      assert.equal((await f.finish(proof)).body.error,undefined);
      protectedState = structuredClone(f.records.get(EXTERNAL_KEY));
    }
    return result;
  };
  const result = await rpc(runtime,{method:'POST',headers:{},body:{jsonrpc:'2.0',id:1,method:'events/subscribe',params:{name:'dot.summoned',arguments:{attempt_id:identity.attemptId,pairing_code:f.code},delivery:{mode:'webhook',url:newUrl,secret:'whsec_'+Buffer.alloc(32,9).toString('base64')},ttlMs:60_000}}});
  assert.equal(admitted,true);
  assert.match(result.body.error?.data?.reason ?? '',/dot_external_credential_(required|rejected)/);
  assert.deepEqual(f.records.get(EXTERNAL_KEY),protectedState);
  assert.equal((await f.dot.ready()).subscription.secret,secret);
});

for (const window of ['connection-cas','external-cas']) test(`old legacy unsubscribe cannot revoke a new attempt candidate (${window})`, async t => {
  const f = await candidateFixture(t), old = await f.dot.current();
  const method = window === 'external-cas' ? 'updateExternal' : 'updateConnection';
  const update = f.dot.store[method].bind(f.dot.store);
  let entered,release;
  const reached = new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  f.dot.store[method] = async fn => { entered(); await gate; return update(fn); };
  const retiring = f.dot.unsubscribe({attemptId:old.attemptId,pairingCode:old.pairingCode,url:old.subscription.url});
  await reached;
  await f.settings.actions['dot.reconnect']({},undefined,f.owner);
  await f.settings.actions['dot.use-long-lived']({input:{longLivedServerUrlTemplate:'https://replacement.example/mcp?token={token}'}},undefined,f.owner);
  await f.settings.actions['dot.show-instructions']({},undefined,f.owner);
  const protectedExternal=structuredClone(f.records.get(EXTERNAL_KEY)),protectedConnection=structuredClone(f.records.get(CONNECTION_KEY));
  assert.notEqual(protectedConnection.value.attemptId,old.attemptId);
  assert.ok(protectedExternal.value.pending);
  release();
  await assert.rejects(retiring,/dot_(stale_connection|candidate_stale|binding_stale)/);
  assert.deepEqual(f.records.get(EXTERNAL_KEY),protectedExternal);
  assert.deepEqual(f.records.get(CONNECTION_KEY),protectedConnection);
  assert.equal(await f.dot.serverUrl(),protectedExternal.value.endpoint.serverUrl);
});

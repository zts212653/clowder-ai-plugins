import assert from "node:assert/strict";
import test from "node:test";
import { createDotPlugin } from "../src/plugin-entrypoint.ts";
import { DotConnection } from "../src/connection.ts";
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
  assert.equal((await f.rpc("events/unsubscribe",{name:"dot.summoned",arguments:{attempt_id:formal.attemptId,pairing_code:formal.pairingCode},delivery:{mode:"webhook",url:formal.subscription.url}},jti)).body.error,undefined);
  assert.equal(f.records.get(EXTERNAL_KEY).value.pending,null);
  assert.equal((await f.dot.current()).subscription,null);
  assert.ok((await f.tool("cat_cafe_dot_read_source",{event_id:id})).body.error);
});

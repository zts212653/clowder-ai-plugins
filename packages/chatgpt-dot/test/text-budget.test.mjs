import assert from 'node:assert/strict';
import test from 'node:test';
import {MESSAGING_BOUNDS,validateMessagingSemantics} from '@clowder-ai/plugin-contract';
import {paired,rpc,delivery} from './fixture.mjs';
import {eventKey} from '../src/store.ts';

async function textFixture(t){
 const f=await paired(t);await f.active.actions.deliverMessage(delivery(f));f.eventId=f.webhooks.at(-1).data.eventId;
 await rpc(f,'cat_cafe_dot_read_source',{event_id:f.eventId});
 f.host.messaging.subscribe=async()=>{};
 const send=f.host.messaging.send;
 f.host.messaging.send=async draft=>{if(!validateMessagingSemantics('MessageDraft',draft).valid)throw new Error('host_messaging_budget_exceeded');return send(draft);};
 f.call=(kind,content)=>rpc(f,kind==='reply'?'cat_cafe_dot_reply':'cat_cafe_dot_ask',kind==='reply'?{event_id:f.eventId,content}:{attempt_id:f.credentials.attemptId,thread_id:'thread-1',target_cat_ids:['cat-1'],client_message_id:'retryable-question',content});
 return f;
}

for(const kind of ['reply','ask'])for(const [name,content] of [['multibyte','猫'.repeat(22000)],['JSON escaped','\u0001'.repeat(11000)]])test(`${kind} rejects oversized ${name} text before reserving and allows a shorter retry`,async t=>{
 const f=await textFixture(t);const result=await f.call(kind,content);assert.ok(result.error);
 assert.equal(f.sent.length,0);
 assert.equal((await f.host.storage.get(eventKey(f.eventId))).value.replyDigest,undefined);
 assert.equal([...f.records.keys()].filter(key=>key.startsWith('dot/ask/')).length,0);
 const retry=await f.call(kind,'short retry');assert.equal(retry.error,undefined,'the same event/client ID must remain usable after invalid text');assert.equal(f.sent.length,1);
});

test('ask counts the prepended recipient mentions before reserving its client ID',async t=>{
 const f=await textFixture(t),content='猫'.repeat(21841);
 assert.ok(Buffer.byteLength(JSON.stringify({text:content}))<=MESSAGING_BOUNDS.maxElementPayloadBytes);
 const result=await f.call('ask',content);assert.ok(result.error);
 assert.equal([...f.records.keys()].filter(key=>key.startsWith('dot/ask/')).length,0);
 assert.equal((await f.call('ask','short retry')).error,undefined);assert.equal(f.sent.length,1);
});

for(const kind of ['reply','ask'])test(`${kind} accepts a text element exactly at the canonical serialized byte limit`,async t=>{
 const f=await textFixture(t),content=kind==='reply'?'猫'.repeat(21841)+'ab':'猫'.repeat(21839);
 assert.equal((await f.call(kind,content)).error,undefined);assert.equal(f.sent.length,1);
 assert.equal(Buffer.byteLength(JSON.stringify(f.sent[0].input.payload.elements[0].payload)),MESSAGING_BOUNDS.maxElementPayloadBytes);
});

test('advertised text schemas expose the canonical UTF-8 JSON budget and ask mention overhead',async t=>{
 const f=await textFixture(t);
 const tools=(await f.active.actions['dot.rpc']({request:{method:'POST',path:'mcp',headers:{'x-dot-credential':f.credentials.credentialSecret},body:{jsonrpc:'2.0',id:1,method:'tools/list'}}})).body.result.tools;
 for(const name of ['cat_cafe_dot_reply','cat_cafe_dot_ask']){
  const description=tools.find(tool=>tool.name===name).inputSchema.properties.content.description??'';
  assert.ok(description.includes(String(MESSAGING_BOUNDS.maxElementPayloadBytes)));assert.match(description,/UTF-8|UTF8/);assert.match(description,/JSON/);
  if(name==='cat_cafe_dot_ask')assert.match(description,/mention/);
 }
});

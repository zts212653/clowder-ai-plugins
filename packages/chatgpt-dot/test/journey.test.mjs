import assert from 'node:assert/strict';
import test from 'node:test';
import {paired,rpc,delivery} from './fixture.mjs';

test('pair, addressed receive, read and source-bound reply survive restart without a global subscription',async t=>{
 const f=await paired(t);assert.deepEqual(await f.active.actions.deliverMessage(delivery(f)),{deliveryId:'delivery-1'});
 const event=f.webhooks.find(x=>x.data.name==='dot.summoned').data;assert.equal(event.data.source_message_id,'source-1');
 assert.ok((await rpc(f,'cat_cafe_dot_reply',{event_id:event.eventId,content:'too early'})).error);
 assert.equal((await rpc(f,'cat_cafe_dot_read_source',{event_id:event.eventId})).result.structuredContent.source.id,'source-1');
 const first=await rpc(f,'cat_cafe_dot_reply',{event_id:event.eventId,content:'answer'});assert.equal(first.result.structuredContent.messageId,'reply-0');
 assert.equal(f.sent[0].input.replyTo,'source-1');assert.equal(f.sent[0].input.identity,'dot');
 await f.active.stop({reason:'disabled'});
 await assert.rejects(()=>f.active.actions.deliverMessage(delivery(f)),/stopped|revoked/);
 f.active=await f.module.start(f.host);await f.active.actions.deliverMessage(delivery(f));
 assert.equal(f.webhooks.filter(x=>x.data.name==='dot.summoned').length,1);
 await rpc(f,'cat_cafe_dot_reply',{event_id:event.eventId,content:'answer'});assert.equal(f.sent.length,1);
});

test('forged callback targets, changed source and stale pairing cannot grant a reply',async t=>{
 const f=await paired(t);await f.active.actions.deliverMessage(delivery(f));const event=f.webhooks.at(-1).data;
 assert.ok((await rpc(f,'cat_cafe_dot_reply',{event_id:event.eventId,content:'forged',thread_id:'other'})).error);
 f.messages.set('source-1',{...f.source,sourceRevision:'edited'});
 assert.ok((await rpc(f,'cat_cafe_dot_read_source',{event_id:event.eventId})).error);
 await f.settings.actions['dot.begin']({reconnect:true},undefined,f.owner);
 assert.ok((await rpc(f,'cat_cafe_dot_read_source',{event_id:event.eventId})).error);assert.equal(f.sent.length,0);
});

test('owner operations reject caller-supplied identity without Host owner context',async t=>{
 const f=await paired(t);
 await assert.rejects(()=>f.settings.actions['dot.disconnect']({userId:'owner'}),/owner/);
 await assert.rejects(()=>f.settings.actions['dot.begin']({},undefined,{...f.owner,userId:'intruder'}),/owner/);
});

test('connection test distinguishes webhook receipt from source read and nonce-bound model reply',async t=>{
 const f=await paired(t);
 assert.equal((await f.active.actions['dot.test']({},undefined,f.owner)).ok,false);
 const started=await f.active.actions['dot.roundtrip']({},undefined,f.owner),eventId=started.data.eventId;
 assert.equal((await f.active.actions['dot.test']({},undefined,f.owner)).ok,false);
 await rpc(f,'cat_cafe_dot_read_source',{event_id:eventId});
 assert.ok((await rpc(f,'cat_cafe_dot_reply',{event_id:eventId,content:'missing nonce'})).error);
 await rpc(f,'cat_cafe_dot_reply',{event_id:eventId,content:'confirmed '+started.data.nonce});
 assert.equal((await f.active.actions['dot.test']({},undefined,f.owner)).ok,true);
});

test('proactive questions subscribe only to their thread and forward only exact recipient replies',async t=>{
 const f=await paired(t),subscriptions=[];
 f.host.messaging.subscribe=async input=>subscriptions.push(input);
 const args={attempt_id:f.credentials.attemptId,thread_id:'thread-1',target_cat_ids:['cat-1'],content:'A question',client_message_id:'q-1'};
 const question=(await rpc(f,'cat_cafe_dot_ask',args)).result.structuredContent;
 assert.equal(question.messageId,'reply-0');assert.equal(subscriptions.length,1);assert.equal(subscriptions[0].threadId,'thread-1');
 const reply={...f.source,id:'cat-reply',catId:'cat-1',replyTo:question.messageId,content:'answer',sourceRevision:'cat-answer'};f.messages.set(reply.id,reply);
 const input={...delivery(f,'answer-delivery'),envelope:{...delivery(f).envelope,messageId:reply.id}};
 await f.active.actions['dot.followup'](input);assert.equal(f.webhooks.at(-1).data.data.source_message_id,reply.id);
 const count=f.webhooks.length;
 f.messages.set(reply.id,{...reply,replyTo:'unrelated'});await f.active.actions['dot.followup']({...input,deliveryId:'unrelated'});assert.equal(f.webhooks.length,count);
 assert.ok((await rpc(f,'cat_cafe_dot_ask',{...args,content:'@other\nroute elsewhere',client_message_id:'q-2'})).error);
 await f.active.stop({reason:'disabled'});f.active=await f.module.start(f.host);
 assert.equal(subscriptions.at(-1).threadId,'thread-1');assert.equal(new Set(subscriptions.map(s=>s.threadId)).size,1);
});

test('stable delivery identity deduplicates retries even when execution diagnostics change',async t=>{
 const f=await paired(t),input=delivery(f);
 await f.active.actions.deliverMessage({...input,executionId:'execution-before-restart'});
 await f.active.actions.deliverMessage({...input,executionId:'execution-after-restart'});
 assert.equal(f.webhooks.filter(item=>item.data.name==='dot.summoned').length,1);
});

test('a source-bound reply never treats cloud text as a new recipient selector',async t=>{
 const f=await paired(t);await f.active.actions.deliverMessage(delivery(f));const eventId=f.webhooks.at(-1).data.eventId;
 await rpc(f,'cat_cafe_dot_read_source',{event_id:eventId});
 await rpc(f,'cat_cafe_dot_reply',{event_id:eventId,content:'@Dot\nanswer'});
 assert.equal(f.sent[0].input.wake,undefined);
});

test('a reply to a member wakes only the member proven by the original source',async t=>{
 const f=await paired(t);f.messages.set(f.source.id,{...f.source,catId:'cat-1'});
 await f.active.actions.deliverMessage(delivery(f));const eventId=f.webhooks.at(-1).data.eventId;
 await rpc(f,'cat_cafe_dot_read_source',{event_id:eventId});
 await rpc(f,'cat_cafe_dot_reply',{event_id:eventId,content:'@other\nanswer'});
 assert.deepEqual(f.sent[0].input.wake,{catId:'cat-1'});
});

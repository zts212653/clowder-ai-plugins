import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {paired,rpc,delivery} from './fixture.mjs';

test('original PNG uses ordinary media_ref streams, stable publication keys, and retained bytes across restart',async t=>{
 const f=await paired(t);await f.active.actions.deliverMessage(delivery(f));const id=f.webhooks.at(-1).data.eventId;
 await rpc(f,'cat_cafe_dot_read_source',{event_id:id});
 const png=await sharp({create:{width:2,height:2,channels:4,background:'red'}}).png().toBuffer();
 const args={event_id:id,publication_key:'image-one',png_base64:png.toString('base64'),alt:'original'};
 const result=(await rpc(f,'cat_cafe_dot_publish_image',args)).result.structuredContent;
 assert.equal(result.original,true);assert.equal(result.width,2);
 const media=f.sent[0].input.payload.elements.find(e=>e.kind==='media_ref');assert.match(media.payload.reference,/^pmr_dot_[a-f0-9]{64}$/);assert.equal(media.payload.reference,result.reference);
 assert.deepEqual(Buffer.concat(await Array.fromAsync(f.active.streams.read(result.reference))),png);
 await rpc(f,'cat_cafe_dot_publish_image',args);assert.equal(f.sent.length,1);
 const different=await sharp({create:{width:2,height:2,channels:4,background:'blue'}}).png().toBuffer();
 assert.ok((await rpc(f,'cat_cafe_dot_publish_image',{...args,png_base64:different.toString('base64')})).error);
 await f.active.stop({reason:'disabled'});await assert.rejects(async()=>Array.fromAsync(f.active.streams.read(result.reference)),/stopped|revoked/);
 f.active=await f.module.start(f.host);assert.deepEqual(Buffer.concat(await Array.fromAsync(f.active.streams.read(result.reference))),png);
});

test('bad PNG and unread-source image calls do not publish a message or consume an image slot',async t=>{
 const f=await paired(t);await f.active.actions.deliverMessage(delivery(f));const id=f.webhooks.at(-1).data.eventId;
 const args={event_id:id,publication_key:'broken',png_base64:Buffer.from('fake').toString('base64')};
 assert.ok((await rpc(f,'cat_cafe_dot_publish_image',args)).error);await rpc(f,'cat_cafe_dot_read_source',{event_id:id});
 assert.ok((await rpc(f,'cat_cafe_dot_publish_image',args)).error);assert.equal(f.sent.length,0);
});

test('shared relay accepts only Host owner context and rejects body/principal impersonation',async t=>{
 const f=await paired(t),input={request:{method:'POST',path:'mcp',headers:{},body:{jsonrpc:'2.0',id:1,method:'tools/list'}}};
 assert.equal((await f.active.actions['dot.rpc'](input)).status,403);
 const context={...f.owner,kind:'owner-http-request',operation:'write'};
 assert.equal((await f.active.actions['dot.rpc'](input,undefined,context)).status,200);
 assert.equal((await f.active.actions['dot.rpc']({...input,request:{...input.request,principal:{kind:'owner',id:'owner'}}})).status,403);
 assert.equal((await f.active.actions['dot.rpc'](input,undefined,{...context,pluginInstanceId:'other'})).status,403);
 assert.equal((await f.active.actions['dot.rpc'](input,undefined,{...context,userId:'other'})).status,403);
});

test('disable aborts an in-flight webhook and rejects its late receipt',async t=>{
 const f=await paired(t);let entered;
 const started=new Promise(resolve=>{entered=resolve;});
 f.sendWebhook=undefined;
 // Use a new supervised runtime whose production transport seam observes the lifecycle signal.
 await f.active.stop({reason:'disabled'});
 const {createDotPlugin}=await import('../src/plugin-entrypoint.ts');
 f.module=createDotPlugin({sendWebhook:async(_url,_headers,_body,signal)=>{
   entered();return new Promise((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
 }});
 f.active=await f.module.start(f.host);
 const sending=f.active.actions.deliverMessage(delivery(f));
 const rejected=assert.rejects(sending,/stopped|revoked/);await started;
 await f.active.stop({reason:'disabled'});await rejected;
 assert.equal(f.sent.length,0);
});

test('shared relay rejects a read-only Host descriptor for mutating MCP requests',async t=>{
 const f=await paired(t),input={request:{method:'POST',path:'mcp',headers:{},body:{jsonrpc:'2.0',id:1,method:'tools/list'}}};
 const context={...f.owner,kind:'owner-http-request',operation:'read'};
 assert.equal((await f.active.actions['dot.rpc'](input,undefined,context)).status,403);
});

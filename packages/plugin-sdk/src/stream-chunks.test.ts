import test from 'node:test';import assert from 'node:assert/strict';
import {createStreamReader} from './stream-chunks.js';
test('stdio chunks keep backpressure and retry references after early return',async()=>{
 const offsets:number[]=[];let requests=0;
 const stream=createStreamReader(async input=>{requests++;offsets.push(input.offset);assert.equal(input.reference,'hmr_retry');assert.equal(input.limit,524288);return input.offset===0?{offset:0,dataBase64:'AQ==',done:false,nextOffset:1}:{offset:1,dataBase64:'Ag==',done:true};},()=>{});
 for await(const bytes of stream.read('hmr_retry')){assert.deepEqual([...bytes],[1]);break;}
 assert.equal(requests,1);const received=[];for await(const bytes of stream.read('hmr_retry'))received.push(...bytes);
 assert.deepEqual(received,[1,2]);assert.deepEqual(offsets,[0,0,1]);
});
test('stdio rejects discontinuous cursors and chunks exceeding the requested limit',async()=>{
 const wrong=createStreamReader(async()=>({offset:0,dataBase64:'AQ==',done:false,nextOffset:2}),()=>{});
 await assert.rejects(async()=>{for await(const bytes of wrong.read('hmr_bad'))void bytes;},/cursor/);
 const large=createStreamReader(async()=>({offset:0,dataBase64:Buffer.alloc(524289).toString('base64'),done:true}),()=>{});
 await assert.rejects(async()=>{for await(const bytes of large.read('hmr_large'))void bytes;},/size/);
});
test('abort discards an in-flight chunk and leaves the source reference retryable',async()=>{
 let finish!:(value:{offset:number;dataBase64:string;done:boolean})=>void,started!:()=>void;
 const ready=new Promise<void>(resolve=>{started=resolve;});let first=true;
 const stream=createStreamReader(async()=>{if(!first)return{offset:0,dataBase64:'AQ==',done:true};first=false;started();return new Promise(resolve=>{finish=resolve;});},()=>{});
 const abort=new AbortController(),reader=stream.read('hmr_retry',{signal:abort.signal})[Symbol.asyncIterator]();
 const pending=reader.next();await ready;abort.abort(new Error('cancelled'));finish({offset:0,dataBase64:'Ag==',done:true});await assert.rejects(pending,/cancelled/);
 const result=[];for await(const bytes of stream.read('hmr_retry'))result.push(...bytes);assert.deepEqual(result,[1]);
});

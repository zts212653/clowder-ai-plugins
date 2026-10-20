import test from 'node:test';import assert from 'node:assert/strict';
import {createFeishuSettings,type SettingsHost} from './settings.js';
import type {FeishuQrBindClient} from './FeishuQrBindClient.js';
test('Feishu QR reload uses private plugin storage and preserves credential targets',async()=>{
 const state=new Map<string,unknown>();const seen:string[]=[];
 const host={storage:{get:async(key:string)=>state.has(key)?{revision:1,value:state.get(key)}:undefined,set:async(key:string,value:unknown)=>{state.set(key,value);return{revision:1};}},config:{get:async()=>undefined},secrets:{get:async()=>undefined},log(){}} as unknown as SettingsHost;
 const client={create:async()=>({qrUrl:'https://feishu.example/qr',qrPayload:'challenge'}),poll:async(value:string)=>{seen.push(value);return{status:'confirmed',appId:'app',appSecret:'secret'};}} as unknown as FeishuQrBindClient;
 const first=await createFeishuSettings(host,client).actions['feishu.qr-generate']!({});
 assert.deepEqual(first,{render:'img',data:{url:'https://feishu.example/qr'}});
 const result=await createFeishuSettings(host,client).actions['feishu.qr-status']!({});
 assert.deepEqual((result as {targetValues:unknown}).targetValues,{appId:'app',appSecret:'secret',connectionMode:'websocket'});assert.deepEqual(seen,['challenge']);
});

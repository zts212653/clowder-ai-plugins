import test from 'node:test';import assert from 'node:assert/strict';
import {createWeixinSettings} from './settings.js';import {WeixinAdapter} from './WeixinAdapter.js';
test('QR polling resumes from plugin storage after settings reload without Host lastResult',async()=>{
 const values=new Map<string,unknown>();const host={storage:{get:async(key:string)=>values.has(key)?{revision:1,value:values.get(key)}:undefined,set:async(key:string,value:unknown)=>{values.set(key,value);return {revision:1};}},config:{get:async()=>undefined},secrets:{get:async()=>undefined},log(){}} as never;
 const fetch=WeixinAdapter.fetchQrCode,poll=WeixinAdapter.pollQrCodeStatus;const seen:string[]=[];
 WeixinAdapter.fetchQrCode=async()=>({qrUrl:'https://weixin.example/qr',qrPayload:'private-challenge'}) as never;
 WeixinAdapter.pollQrCodeStatus=async value=>{seen.push(value);return {status:'confirmed',botToken:'credential'} as never;};
 try {
  const generated=await createWeixinSettings(host).actions['weixin.qr-generate']!({input:{}}) as any;
  assert.equal(generated.data.qrPayload,undefined,'challenge stays in package state rather than action data');
  const confirmed=await createWeixinSettings(host).actions['weixin.qr-status']!({input:{}}) as any;
  assert.deepEqual(confirmed.targetValues,{botToken:'credential'});assert.deepEqual(seen,['private-challenge']);
 }finally{WeixinAdapter.fetchQrCode=fetch;WeixinAdapter.pollQrCodeStatus=poll;}
});
test('a superseded QR generation cannot persist its late challenge',async()=>{
 let stored=false,expired=false,finish!:(value:any)=>void;
 let started!:()=>void;const providerStarted=new Promise<void>(resolve=>{started=resolve;});
 const host={storage:{set:async()=>{stored=true;return {revision:1};}}} as never;
 const fetch=WeixinAdapter.fetchQrCode;
 WeixinAdapter.fetchQrCode=()=>new Promise(resolve=>{finish=resolve;started();});
 try{
  const generate=createWeixinSettings(host).actions['weixin.qr-generate']! as (...args:any[])=>Promise<unknown>;
  const pending=generate({input:{}},undefined,{async assertCurrent(){if(expired)throw new Error('superseded');}});
  await providerStarted;expired=true;finish({qrUrl:'https://weixin.example/old',qrPayload:'late'});
  await assert.rejects(pending,/superseded/);assert.equal(stored,false);
 }finally{WeixinAdapter.fetchQrCode=fetch;}
});

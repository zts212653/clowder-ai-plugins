import {createServer} from 'node:net';
import type {PluginActionHandler, PluginOwnerHttpContext, PluginStorageHost} from '@clowder-ai/plugin-sdk';

export function memoryStorage():PluginStorageHost {
 const entries=new Map<string,{revision:number;value:unknown}>();let revision=0;
 return {get:async key=>structuredClone(entries.get(key)),list:async()=>structuredClone(Object.fromEntries(entries)),
  set:async(key,value)=>{entries.set(key,{revision:++revision,value:structuredClone(value)});return {revision};},
  compareAndSet:async(key,expected,value)=>{if((entries.get(key)?.revision??null)!==expected)return {applied:false};entries.set(key,{revision:++revision,value:structuredClone(value)});return {applied:true,revision};},
  delete:async(key,expected)=>({deleted:expected!==undefined&&entries.get(key)?.revision!==expected?false:entries.delete(key)})};
}
export function serviceHostConfig() {
 let port:Promise<number>|undefined;
 return {async get(key:string) {
  if(key!=='servicePort')return undefined;
  port??=(async()=>{const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('Missing test port');await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return address.port;})();
  return String(await port);
 }};
}
/** The fixture explicitly authenticates its fixed local owner, never a body user ID. */
export function ownerCaller(userId:string,method='GET',assertCurrent:()=>Promise<void>=async()=>{}):PluginOwnerHttpContext {
 return {kind:'owner-http-request',userId,pluginInstanceId:'installed-instance',operation:method==='GET'?'read':'write',signal:new AbortController().signal,assertCurrent};
}
export function ownerAction(handler:PluginActionHandler,userId:string,assertCurrent:()=>Promise<void>=async()=>{}) {
 return (input:any,native?:unknown,caller?:unknown)=>handler(input,native as never,(caller??ownerCaller(userId,input.request.method,assertCurrent)) as PluginOwnerHttpContext);
}

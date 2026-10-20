import test from 'node:test';import assert from 'node:assert/strict';
import * as sdk from './index.js';
import {createConnectorPermissionStore} from './connector-permissions.js';
import type {PluginStorageHost} from './module-host.js';
test('SDK exposes no permission read/apply/import action workflow',()=>{assert.equal(Object.hasOwn(sdk,'createConnectorPermissionActions'),false);});
test('ordinary owner policy replacement preserves labels and timestamps under CAS',async()=>{
 const entries=new Map<string,{revision:number;value:unknown}>();let revision=0;
 const host:PluginStorageHost={get:async key=>entries.get(key),list:async()=>Object.fromEntries(entries),set:async(key,value)=>{const item={revision:++revision,value};entries.set(key,item);return item;},compareAndSet:async(key,expected,value)=>{if((entries.get(key)?.revision??null)!==expected)return {applied:false};const next=++revision;entries.set(key,{revision:next,value});return{applied:true,revision:next};},delete:async key=>({deleted:entries.delete(key)})};
 const store=createConnectorPermissionStore(host);assert.equal(await store.readForOwner(),undefined);assert.deepEqual(await host.list(),{});
 const input={expectedRevision:null,whitelistEnabled:true,commandAdminOnly:true,adminOpenIds:[],allowedGroups:[{externalChatId:'g',label:'Group'}]};
 const first=await store.configure(input,5);assert.equal(first.value.allowedGroups[0]?.addedAt,5);
 const changed=await store.configure({...input,expectedRevision:first.revision,allowedGroups:[{externalChatId:'g',label:'Renamed'}]},10);
 assert.equal(changed.value.allowedGroups[0]?.addedAt,5);assert.equal(changed.value.allowedGroups[0]?.label,'Renamed');await assert.rejects(store.configure({...input,expectedRevision:first.revision}),/changed/);
});

import assert from 'node:assert/strict';import test from 'node:test';
import {CurrentDirectory}from'../src/current-directory.mjs';
const turn=()=>new Promise(r=>setImmediate(r));
test('directory polling returns immediately, retains uncertain ids and only selects a verified current snapshot',async()=>{
  const identity={accountGeneration:1,accountIdentity:'owner',connected:true};const ids=[];let fail=true,release;
  const record=id=>({operationId:id,accountGeneration:1,accountIdentity:'owner',phase:'ready',verifiedCount:1,retryAfterMs:0,unverifiedCount:2,groupDiscoveryIncomplete:true,observedAt:Date.now()});
  const client={accountId:id=>assert.equal(id,'clowder'),identity:async()=>identity,
    directoryStart:async id=>{ids.push(id);if(fail)throw Error('unknown');return {...record(id),phase:'catalog'};},
    directoryAdvance:id=>new Promise(r=>release=()=>r(record(id))),
    directoryPage:async id=>({directory:record(id),items:[{id:'friend',kind:'direct',displayName:'Test Friend'}],nextOffset:null}),invalid:()=>{throw Error('invalid native projection');}};
  const directory=new CurrentDirectory(client);assert.equal((await directory.page('clowder')).pending,true);await turn();
  await assert.rejects(directory.page('clowder'));directory.refresh();fail=false;
  assert.equal((await directory.page('clowder')).pending,true);await turn();assert.equal(ids[0],ids[1]);
  assert.equal((await directory.page('clowder')).pending,true);assert.equal(directory.pending(),true);
  release();await turn();const page=await directory.page('clowder');assert.equal(page.pending,false);assert.equal(page.items[0].id,'friend');assert.equal(page.unverifiedCount,2);assert.equal(page.groupDiscoveryIncomplete,true);
  identity.accountIdentity='different';await assert.rejects(directory.page('clowder'),/identity/);
});

test('concurrent first-page reads create a single directory intent while identity observation is pending',async()=>{
  let resolveIdentity;const identity=new Promise(r=>resolveIdentity=r);let starts=0;
  const client={accountId:()=>{},identity:()=>identity,directoryStart:async id=>{starts++;return{operationId:id,accountGeneration:1,accountIdentity:'owner',phase:'catalog',retryAfterMs:0};}};
  const directory=new CurrentDirectory(client);
  const first=directory.page('clowder'),second=directory.page('clowder');
  resolveIdentity({accountGeneration:1,accountIdentity:'owner',connected:true});await Promise.all([first,second]);await turn();
  assert.equal(starts,1);
});

test('bounded native pages cover the complete directory and UI cursors stay with their query and snapshot',async()=>{
 const identity={accountGeneration:1,accountIdentity:'owner',connected:true};let pages=0;
 const items=[...Array.from({length:145},(_,i)=>({id:`club-${i}@chatroom`,kind:'group',displayName:`周末读书群 ${i}`})),{id:'book-lover',kind:'direct',displayName:'读书好友'}];
 const record=id=>({operationId:id,accountGeneration:1,accountIdentity:'owner',phase:'ready',verifiedCount:items.length,retryAfterMs:0,unverifiedCount:0,groupDiscoveryIncomplete:false,observedAt:Date.now()});
 const client={accountId:id=>{if(id!=='clowder')throw Error('invalid account');},identity:async()=>identity,directoryStart:async id=>record(id),directoryPage:async(id,offset)=>{pages++;return{directory:record(id),items:items.slice(offset,offset+100),nextOffset:offset+100<items.length?offset+100:null};},invalid:()=>{throw Error('invalid');}};
 const directory=new CurrentDirectory(client);await directory.page('clowder');await turn();assert.equal(pages,2);
 const query={query:'周书群',kind:'group',limit:20};const first=await directory.page('clowder','',query),second=await directory.page('clowder',first.nextCursor,query);
 assert.equal(first.total,145);assert.equal(first.items.length,20);assert.equal(new Set([...first.items,...second.items].map(item=>item.id)).size,40);
 await assert.rejects(directory.page('clowder',first.nextCursor,{...query,query:'other'}),/cursor/);
 await assert.rejects(directory.page('foreign',first.nextCursor,query),/account/);
 assert.deepEqual((await directory.page('clowder','',{query:'book-love',kind:'direct',limit:20})).items.map(item=>item.id),['book-lover']);
 directory.refresh();await assert.rejects(directory.page('clowder',first.nextCursor,query),/expired/);
});

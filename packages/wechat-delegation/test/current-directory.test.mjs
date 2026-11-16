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

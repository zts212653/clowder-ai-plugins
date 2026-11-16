import assert from 'node:assert/strict';import test from 'node:test';import{SyncState}from'../src/sync-state.mjs';
const identity=(overrides={})=>({serverId:'process',stream:{sourceRef:'source',resetEpoch:0,eventCursor:'0',caughtUp:true},...overrides});
test('a fresh process must observe complete sync itself; partial pages do not establish a safe initial baseline',async()=>{
 const state=new SyncState();const owner=identity();let calls=0,release;
 const client={pull:()=>{calls++;return new Promise(r=>release=r);}};
 assert.equal(state.snapshot(owner).ready,false);const a=state.pull(client,owner),b=state.pull(client,owner);assert.equal(calls,1);
 release({stream:{sourceRef:'source',resetEpoch:0,eventCursor:'5',caughtUp:false},reset:false});assert.equal((await a).initialized,false);await b;
 client.pull=async()=>({stream:{sourceRef:'source',resetEpoch:0,eventCursor:'7',caughtUp:true},reset:false});await state.pull(client,owner);assert.equal(state.snapshot(owner).ready,true);
 assert.equal(state.snapshot(identity({serverId:'new-process'})).ready,false);
});
test('reset and source changes invalidate prior readiness while ordinary new partial pages preserve the established baseline',async()=>{
 const state=new SyncState();const owner=identity();let page={stream:{...owner.stream,eventCursor:'1'},reset:false};const client={pull:async()=>page};
 await state.pull(client,owner);page={stream:{...owner.stream,eventCursor:'2',caughtUp:false},reset:false};assert.equal((await state.pull(client,owner)).initialized,true);assert.equal(state.snapshot(owner).ready,false);
 page={stream:{...owner.stream,resetEpoch:1,eventCursor:'3',caughtUp:false},reset:true};const reset=await state.pull(client,owner);assert.equal(reset.initialized,false);assert.equal(reset.changed,true);assert.equal(state.snapshot(owner).ready,false);
});

test('a new owned client cannot share an old pending pull or be overwritten by its late result',async()=>{
 const state=new SyncState();let finish;const old=state.pull({pull:()=>new Promise(r=>finish=r)},identity());let newCalls=0;
 const nextIdentity=identity({serverId:'new-process',stream:{sourceRef:'new-source',resetEpoch:0,eventCursor:'0',caughtUp:true}});
 const next=state.pull({pull:async()=>{newCalls++;return{stream:{...nextIdentity.stream,eventCursor:'5'},reset:false};}},nextIdentity);
 const called=newCalls;finish({stream:{sourceRef:'source',resetEpoch:0,eventCursor:'99',caughtUp:true},reset:false});await Promise.all([old,next]);
 assert.equal(called,1);assert.equal(state.snapshot(nextIdentity).sourceRef,'new-source');assert.equal(state.snapshot(nextIdentity).ready,true);
});

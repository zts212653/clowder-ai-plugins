import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {createDotPlugin} from '../src/plugin-entrypoint.ts';
import {importLegacyBatch} from '../src/migration.ts';
import {CONNECTION_KEY,eventId,eventKey} from '../src/store.ts';
import {paired,fixture} from './fixture.mjs';
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}
async function legacy(t){
 const old=await paired(t),connection=structuredClone((await old.host.storage.get(CONNECTION_KEY)).value);connection.pluginInstanceId='legacy-instance';
 const f=fixture(t);f.host.dataPath=await mkdtemp(join(tmpdir(),'dot-import-authority-'));t.after(()=>rm(f.host.dataPath,{recursive:true,force:true}));
 const id=eventId(connection.attemptId,'thread-1','source-1','run'),dispatch={eventId:id,ownerUserId:'owner',threadId:'thread-1',sourceMessageId:'source-1',dispatchInvocationId:'run',attemptId:connection.attemptId,agentKeyId:connection.agentKeyId,occurredAt:1,webhookAcknowledgedAt:null,sourceReadAt:null,replyMessageId:null,imagePublicationIds:[],connectionTest:false};
 const png=await sharp({create:{width:2,height:2,channels:4,background:'red'}}).png().toBuffer(),assetId='dot_img_'+'d'.repeat(64);
 const image={metadata:{id:assetId,ownerUserId:'owner',threadId:'thread-1',eventId:id,publicationKey:'one',sha256:createHash('sha256').update(png).digest('hex'),byteSize:png.length,width:2,height:2,messageId:null,alt:'original'},png_base64:png.toString('base64')};
 return{f,batch:{version:1,ownerUserId:'owner',sourceInstanceId:'legacy-instance',connection,dispatches:[dispatch],images:[image]},keys:{connection:CONNECTION_KEY,dispatch:eventKey(id),image:'dot/image/'+assetId}};
}

for(const target of ['connection','dispatch','image'])test(`migration cannot CAS ${target} after its owner fence expires during read`,async t=>{
 const {f,batch,keys}=await legacy(t),entered=deferred(),release=deferred(),get=f.host.storage.get;
 let reads=0,current=true;
 f.host.storage.get=async key=>{const value=await get(key);if(key===keys[target]&&++reads===(target==='connection'?2:1)){entered.resolve();await release.promise;}return value;};
 const context={...f.owner,assertCurrent:async()=>{if(!current)throw new Error('owner_fence_revoked');}};
 const pending=importLegacyBatch(f.host,batch,context),rejected=assert.rejects(pending,/owner_fence_revoked/);
 await entered.promise;current=false;release.resolve();await rejected;
 assert.equal(f.records.has(keys[target]),false,'expired authority cannot retain the pending record');
 assert.equal([...f.records.keys()].some(key=>key.startsWith('dot/migration/receipt/')),false);
});

test('dormant settings disposal revokes migration before a pending connection CAS',async t=>{
 const {f,batch}=await legacy(t),entered=deferred(),release=deferred(),get=f.host.storage.get;let reads=0;
 f.host.storage.get=async key=>{const value=await get(key);if(key===CONNECTION_KEY&&++reads===2){entered.resolve();await release.promise;}return value;};
 const settings=await createDotPlugin().settings(f.host);
 const pending=settings.actions['dot.import'](batch,undefined,f.owner),rejected=assert.rejects(pending,/revoked/);
 await entered.promise;await settings.dispose();release.resolve();await rejected;
 assert.equal(f.records.has(CONNECTION_KEY),false);
});

test('a cached migration receipt is not returned after owner revocation during its read',async t=>{
 const {f,batch}=await legacy(t);await importLegacyBatch(f.host,batch,f.owner);
 const entered=deferred(),release=deferred(),get=f.host.storage.get;let current=true;
 f.host.storage.get=async key=>{const value=await get(key);if(key.startsWith('dot/migration/receipt/')){entered.resolve();await release.promise;}return value;};
 const context={...f.owner,assertCurrent:async()=>{if(!current)throw new Error('owner_fence_revoked');}};
 const pending=importLegacyBatch(f.host,batch,context),rejected=assert.rejects(pending,/owner_fence_revoked/);
 await entered.promise;current=false;release.resolve();await rejected;
});

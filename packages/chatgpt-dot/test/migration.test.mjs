import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {importLegacyBatch} from '../src/migration.ts';
import {CONNECTION_KEY,eventId,eventKey} from '../src/store.ts';
import {paired,fixture} from './fixture.mjs';

test('legacy import preserves pairing, old dispatch/reply IDs and original bytes while rebinding only the instance',async t=>{
 const old=await paired(t),connection=structuredClone((await old.host.storage.get(CONNECTION_KEY)).value);
 connection.pluginInstanceId='legacy-instance';
 const f=fixture(t);f.host.dataPath=await mkdtemp(join(tmpdir(),'dot-import-'));t.after(()=>rm(f.host.dataPath,{recursive:true,force:true}));
 const id=eventId('previous-attempt','thread-1','old-source','old-run');
 const dispatch={eventId:id,ownerUserId:'owner',threadId:'thread-1',sourceMessageId:'old-source',dispatchInvocationId:'old-run',attemptId:'previous-attempt',agentKeyId:'old-key',occurredAt:1,webhookAcknowledgedAt:2,sourceReadAt:3,replyMessageId:'old-reply',imagePublicationIds:['dot_img_'+'a'.repeat(64)],connectionTest:false};
 const png=await sharp({create:{width:2,height:3,channels:4,background:'#556677'}}).png().toBuffer();
 const image={metadata:{id:dispatch.imagePublicationIds[0],ownerUserId:'owner',threadId:'thread-1',eventId:id,publicationKey:'one',sha256:createHash('sha256').update(png).digest('hex'),byteSize:png.length,width:2,height:3,messageId:'old-reply',alt:'original'},png_base64:png.toString('base64')};
 const batch={version:1,ownerUserId:'owner',sourceInstanceId:'legacy-instance',connection,dispatches:[dispatch],images:[image]};
 const result=await importLegacyBatch(f.host,batch,f.owner);assert.equal(result.sourceDeleted,false);assert.equal(result.images,1);
 const state=(await f.host.storage.get(CONNECTION_KEY)).value;
 assert.equal(state.credentialSecret,connection.credentialSecret);assert.equal(state.attemptId,connection.attemptId);assert.deepEqual(state.subscription,connection.subscription);assert.equal(state.pluginInstanceId,f.host.pluginInstanceId);
 assert.deepEqual((await f.host.storage.get(eventKey(id))).value,dispatch);
 assert.deepEqual(await readFile(join(f.host.dataPath,'images',image.metadata.id+'.png')),png);
 const duplicate=await importLegacyBatch(f.host,batch,f.owner);assert.equal(duplicate.batchDigest,result.batchDigest);assert.equal(duplicate.duplicate,true);
 assert.equal(connection.pluginInstanceId,'legacy-instance');
});

test('import rejects a wrong owner before retaining secrets or user records',async t=>{
 const f=fixture(t);await assert.rejects(()=>importLegacyBatch(f.host,{version:1,ownerUserId:'other',sourceInstanceId:'old'},f.owner),/owner/);assert.equal(f.records.size,0);
});

test('legacy connection revocation strengthens an imported credential and never restores or replaces it',async t=>{
 const old=await paired(t),connection=structuredClone((await old.host.storage.get(CONNECTION_KEY)).value);connection.pluginInstanceId='legacy-instance';
 const f=fixture(t),batch={version:1,ownerUserId:'owner',sourceInstanceId:'legacy-instance',connection};
 await importLegacyBatch(f.host,batch,f.owner);
 const revoked={...batch,connection:{...connection,revokedAt:100}};
 await importLegacyBatch(f.host,revoked,f.owner);
 assert.equal((await f.host.storage.get(CONNECTION_KEY)).value.revokedAt,100);
 await importLegacyBatch(f.host,batch,f.owner);
 await importLegacyBatch(f.host,{...batch,connection:{...connection,revokedAt:200}},f.owner);
 assert.equal((await f.host.storage.get(CONNECTION_KEY)).value.revokedAt,100);
 const conflict={...revoked,connection:{...revoked.connection,credentialSecret:'e'.repeat(64)}};
 await assert.rejects(()=>importLegacyBatch(f.host,conflict,f.owner),/conflict/);
});

test('revocation survives CAS contention, receipt failure and concurrent stale import retries',async t=>{
 const old=await paired(t),connection=structuredClone((await old.host.storage.get(CONNECTION_KEY)).value);connection.pluginInstanceId='legacy-instance';
 const f=fixture(t),batch={version:1,ownerUserId:'owner',sourceInstanceId:'legacy-instance',connection};
 await importLegacyBatch(f.host,batch,f.owner);
 const cas=f.host.storage.compareAndSet.bind(f.host.storage);let contend=true,crash=true;
 f.host.storage.compareAndSet=async(key,revision,value)=>{
  if(key===CONNECTION_KEY&&value.revokedAt===100&&contend){contend=false;const current=(await f.host.storage.get(key)).value;await f.host.storage.set(key,{...current,lastReplyAt:42});}
  if(key.startsWith('dot/migration/receipt/')&&crash)throw new Error('simulated_crash');
  return cas(key,revision,value);
 };
 const revoked={...batch,connection:{...connection,revokedAt:100}};
 await assert.rejects(()=>importLegacyBatch(f.host,revoked,f.owner),/simulated_crash/);
 assert.equal(contend,false);assert.equal((await f.host.storage.get(CONNECTION_KEY)).value.revokedAt,100);
 crash=false;
 const receipts=await Promise.all([importLegacyBatch(f.host,revoked,f.owner),importLegacyBatch(f.host,revoked,f.owner),importLegacyBatch(f.host,batch,f.owner)]);
 assert.equal(receipts[0].batchDigest,receipts[1].batchDigest);
 const state=(await f.host.storage.get(CONNECTION_KEY)).value;
 assert.equal(state.revokedAt,100);assert.equal(state.lastReplyAt,42);
});

test('interrupted import resumes after runtime evidence advances, without overwriting read/reply/image facts',async t=>{
 const old=await paired(t),connection=structuredClone((await old.host.storage.get(CONNECTION_KEY)).value);connection.pluginInstanceId='legacy-instance';
 const f=fixture(t),id=eventId(connection.attemptId,'thread-1','source-1','run');
 const dispatch={eventId:id,ownerUserId:'owner',threadId:'thread-1',sourceMessageId:'source-1',dispatchInvocationId:'run',attemptId:connection.attemptId,agentKeyId:connection.agentKeyId,occurredAt:1,webhookAcknowledgedAt:null,sourceReadAt:null,replyMessageId:null,imagePublicationIds:[],connectionTest:false};
 f.host.dataPath=await mkdtemp(join(tmpdir(),'dot-interrupted-import-'));t.after(()=>rm(f.host.dataPath,{recursive:true,force:true}));
 const png=await sharp({create:{width:2,height:3,channels:4,background:'#123456'}}).png().toBuffer();
 const asset={id:'dot_img_'+'b'.repeat(64),ownerUserId:'owner',threadId:'thread-1',eventId:id,publicationKey:'pending',sha256:createHash('sha256').update(png).digest('hex'),byteSize:png.length,width:2,height:3,messageId:null,alt:'pending original'};
 const batch={version:1,ownerUserId:'owner',sourceInstanceId:'legacy-instance',connection,dispatches:[dispatch],images:[{metadata:asset,png_base64:png.toString('base64')}]};
 const cas=f.host.storage.compareAndSet.bind(f.host.storage);let interrupt=true;
 f.host.storage.compareAndSet=async(key,...args)=>{if(interrupt&&key.startsWith('dot/migration/receipt/'))throw new Error('simulated_crash');return cas(key,...args);};
 await assert.rejects(()=>importLegacyBatch(f.host,batch,f.owner),/simulated_crash/);interrupt=false;
 const advanced={...dispatch,webhookAcknowledgedAt:10,sourceReadAt:11,replyMessageId:'new-reply',imagePublicationIds:['new-image'],sourceRevision:'new-rev',replyDigest:'new-digest'};
 await f.host.storage.set(eventKey(id),advanced);
 await f.host.storage.set('dot/image/'+asset.id,{...asset,messageId:'new-reply'});
 const result=await importLegacyBatch(f.host,batch,f.owner);assert.ok(result.alreadyPresent>=1);
 assert.deepEqual((await f.host.storage.get(eventKey(id))).value,advanced);
 assert.equal((await f.host.storage.get('dot/image/'+asset.id)).value.messageId,'new-reply');
 assert.deepEqual(await readFile(join(f.host.dataPath,'images',asset.id+'.png')),png);
 const conflict={...batch,dispatches:[{...dispatch,sourceMessageId:'different-source'}]};
 await assert.rejects(()=>importLegacyBatch(f.host,conflict,f.owner),/conflict/);
});

test('migration requires the Host-only owner-operation fence and is absent from active actions',async t=>{
 const f=await paired(t);
 assert.equal(Object.hasOwn(f.active.actions,'dot.import'),false);
 await assert.rejects(()=>importLegacyBatch(f.host,{version:1,ownerUserId:'owner',sourceInstanceId:'old'},{...f.owner,kind:'owner-http-request',operation:'write'}),/owner/);
 await f.settings.dispose();await assert.rejects(()=>f.settings.actions['dot.begin']({},undefined,f.owner),/revoked/);
});

for(const conflict of [true,false])test(conflict?'conflicting concurrent image imports cannot overwrite the original retained by the winning batch':'identical concurrent image imports reuse the winning original and receipt',async t=>{
 const old=await paired(t),connection=structuredClone((await old.host.storage.get(CONNECTION_KEY)).value);connection.pluginInstanceId='legacy-instance';
 const f=fixture(t);f.host.dataPath=await mkdtemp(join(tmpdir(),'dot-image-race-'));t.after(()=>rm(f.host.dataPath,{recursive:true,force:true}));
 const id=eventId(connection.attemptId,'thread-1','source-1','run');
 const dispatch={eventId:id,ownerUserId:'owner',threadId:'thread-1',sourceMessageId:'source-1',dispatchInvocationId:'run',attemptId:connection.attemptId,agentKeyId:connection.agentKeyId,occurredAt:1,webhookAcknowledgedAt:null,sourceReadAt:null,replyMessageId:null,imagePublicationIds:[],connectionTest:false};
 const first=await sharp({create:{width:2,height:3,channels:4,background:'#123456'}}).png().toBuffer();
 const winner=conflict?await sharp({create:{width:2,height:3,channels:4,background:'#abcdef'}}).png().toBuffer():first;
 const assetId='dot_img_'+'c'.repeat(64);
 const batch=bytes=>({version:1,ownerUserId:'owner',sourceInstanceId:'legacy-instance',connection,dispatches:[dispatch],images:[{metadata:{id:assetId,ownerUserId:'owner',threadId:'thread-1',eventId:id,publicationKey:'racing',sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length,width:2,height:3,messageId:null,alt:'original'},png_base64:bytes.toString('base64')}]});
 let interleaved=false;
 const context={...f.owner,assertCurrent:async()=>{
  if(interleaved)return;
  const entries=await readdir(join(f.host.dataPath,'images')).catch(error=>{if(error.code==='ENOENT')return[];throw error;});
  if(entries.some(name=>name.endsWith('.tmp'))){interleaved=true;await importLegacyBatch(f.host,batch(winner),f.owner);}
 }};
 if(conflict)await assert.rejects(()=>importLegacyBatch(f.host,batch(first),context),/conflict/);
 else assert.equal((await importLegacyBatch(f.host,batch(first),context)).duplicate,true);
 assert.equal(interleaved,true);
 assert.deepEqual(await readFile(join(f.host.dataPath,'images',assetId+'.png')),winner);
 assert.equal((await f.host.storage.get('dot/image/'+assetId)).value.sha256,createHash('sha256').update(winner).digest('hex'));
 assert.equal((await importLegacyBatch(f.host,batch(winner),f.owner)).duplicate,true);
});

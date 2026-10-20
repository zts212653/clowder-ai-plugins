import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {createDotPlugin} from '../src/plugin-entrypoint.ts';
import {importLegacyBatch,legacyImportSchema} from '../src/migration.ts';
import {CONNECTION_KEY,digest,eventId,eventKey} from '../src/store.ts';
import {fixture,paired} from './fixture.mjs';

async function imported(t) {
 const old=await paired(t),connection=structuredClone((await old.host.storage.get(CONNECTION_KEY)).value);
 connection.pluginInstanceId='legacy-instance';
 const f=fixture(t);f.host.dataPath=await mkdtemp(join(tmpdir(),'dot-reinstall-'));t.after(()=>rm(f.host.dataPath,{recursive:true,force:true}));
 const id=eventId(connection.attemptId,'thread-1','source-1','legacy-run');
 const dispatch={eventId:id,ownerUserId:'owner',threadId:'thread-1',sourceMessageId:'source-1',dispatchInvocationId:'legacy-run',attemptId:connection.attemptId,agentKeyId:connection.agentKeyId,occurredAt:1,webhookAcknowledgedAt:null,sourceReadAt:null,replyMessageId:null,imagePublicationIds:[],connectionTest:false};
 const png=await sharp({create:{width:2,height:3,channels:4,background:'blue'}}).png().toBuffer();
 const image={metadata:{id:'dot_img_'+'c'.repeat(64),ownerUserId:'owner',threadId:'thread-1',eventId:id,publicationKey:'original',sha256:createHash('sha256').update(png).digest('hex'),byteSize:png.length,width:2,height:3,messageId:null,alt:'original'},png_base64:png.toString('base64')};
 const batch={version:1,ownerUserId:'owner',sourceInstanceId:'legacy-instance',connection,dispatches:[dispatch],images:[image]};
 const module=createDotPlugin({sendWebhook:f.sendWebhook}),settings=await module.settings(f.host);
 t.after(()=>settings.dispose());
 const receipt=(await settings.actions['dot.import'](batch,undefined,f.owner)).data;
 const host={...f.host,pluginInstanceId:'installed-dot-2'},owner={...f.owner,pluginInstanceId:host.pluginInstanceId,actionId:'dot.import'};
 return{f,batch,png,module,receipt,host,owner};
}
const tools=(active,secret)=>active.actions['dot.rpc']({request:{method:'POST',path:'mcp',headers:{'x-dot-credential':secret},body:{jsonrpc:'2.0',id:1,method:'tools/list'}}});

test('retained data survives stop/uninstall/reinstall and the same legacy batch returns a new-instance receipt and usable credential',async t=>{
 const {f,batch,png,module,receipt,host,owner}=await imported(t);
 // Model data from the previously accepted package's unscoped receipt as well.
 await f.host.storage.set('dot/migration/receipt/'+digest(legacyImportSchema.parse(batch)),receipt);
 const active=await module.start(f.host);assert.equal((await tools(active,batch.connection.credentialSecret)).status,200);
 await active.stop();await module.uninstall(f.host);
 const before=(await f.host.storage.get(CONNECTION_KEY)).value;
 await f.host.storage.set(CONNECTION_KEY,{...before,lastReplyAt:42});
 const dispatch=batch.dispatches[0],advanced={...dispatch,sourceReadAt:10,replyMessageId:'runtime-reply',imagePublicationIds:['runtime-image']};
 await f.host.storage.set(eventKey(dispatch.eventId),advanced);
 const reinstalled=createDotPlugin({sendWebhook:f.sendWebhook}),settings=await reinstalled.settings(host);t.after(()=>settings.dispose());
 const rebound=(await settings.actions['dot.import'](batch,undefined,owner)).data;
 assert.equal(rebound.pluginInstanceId,host.pluginInstanceId);
 assert.equal(rebound.duplicate,undefined,'the old target receipt cannot complete a new installation');
 const retained=(await host.storage.get(CONNECTION_KEY)).value;
 assert.deepEqual(retained,{...before,lastReplyAt:42,pluginInstanceId:host.pluginInstanceId});
 assert.deepEqual((await host.storage.get(eventKey(dispatch.eventId))).value,advanced);
 assert.deepEqual(await readFile(join(host.dataPath,'images',batch.images[0].metadata.id+'.png')),png);
 assert.deepEqual((await host.storage.get('dot/migration/receipt/'+digest(legacyImportSchema.parse(batch)))).value,receipt,'legacy receipt remains retained');
 const duplicate=(await settings.actions['dot.import'](batch,undefined,owner)).data;
 assert.equal(duplicate.duplicate,true);assert.equal(duplicate.pluginInstanceId,host.pluginInstanceId);
 const restarted=await reinstalled.start(host);t.after(()=>restarted.stop());
 assert.equal((await tools(restarted,batch.connection.credentialSecret)).status,200);
});

test('new installation must rebind connection before replaying an already-imported dispatch batch',async t=>{
 const {f,batch,host,owner}=await imported(t),records={...batch,connection:undefined};
 const oldReceipt=await importLegacyBatch(f.host,records,f.owner);
 await assert.rejects(()=>importLegacyBatch(host,records,owner),/connection_required/);
 await importLegacyBatch(host,batch,owner);
 const result=await importLegacyBatch(host,records,owner);
 assert.notEqual(result.pluginInstanceId,oldReceipt.pluginInstanceId);assert.equal(result.pluginInstanceId,host.pluginInstanceId);
});

test('instance rebind preserves first revocation and runtime evidence across receipt failure, CAS contention and stale retries',async t=>{
 const {f,batch,host,owner}=await imported(t),cas=f.host.storage.compareAndSet.bind(f.host.storage);let contend=true,crash=true;
 f.host.storage.compareAndSet=async(key,revision,value)=>{
  if(key===CONNECTION_KEY&&contend){contend=false;const current=(await f.host.storage.get(key)).value;await f.host.storage.set(key,{...current,revokedAt:50,lastImageAt:99});}
  if(key.startsWith('dot/migration/receipt/')&&crash)throw new Error('receipt_crash');
  return cas(key,revision,value);
 };
 const revoked={...batch,connection:{...batch.connection,revokedAt:100}};
 await assert.rejects(()=>importLegacyBatch(host,revoked,owner),/receipt_crash/);
 assert.equal(contend,false);crash=false;
 const results=await Promise.all([importLegacyBatch(host,revoked,owner),importLegacyBatch(host,batch,owner)]);
 assert.ok(results.every(r=>r.pluginInstanceId===host.pluginInstanceId));
 const current=(await host.storage.get(CONNECTION_KEY)).value;
 assert.equal(current.pluginInstanceId,host.pluginInstanceId);assert.equal(current.revokedAt,50);assert.equal(current.lastImageAt,99);
});

test('reinstall cannot revive a disconnected retained credential from an active legacy snapshot',async t=>{
 const {f,batch,host,owner}=await imported(t),state=(await f.host.storage.get(CONNECTION_KEY)).value;
 await f.host.storage.set(CONNECTION_KEY,{...state,revokedAt:123});
 const receipt=await importLegacyBatch(host,batch,owner);assert.equal(receipt.pluginInstanceId,host.pluginInstanceId);
 assert.equal((await host.storage.get(CONNECTION_KEY)).value.revokedAt,123);
 const module=createDotPlugin({sendWebhook:f.sendWebhook}),active=await module.start(host);t.after(()=>active.stop());
 assert.equal((await tools(active,batch.connection.credentialSecret)).status,403);
});

for(const field of ['ownerUserId','attemptId','agentKeyId','credentialSecret','pairingCode'])test(`retained connection cannot rebind with conflicting ${field}`,async t=>{
 const {f,batch,host,owner}=await imported(t),before=structuredClone(f.records);
 const connection={...batch.connection,[field]:field==='credentialSecret'?'e'.repeat(64):field==='pairingCode'?'f'.repeat(32):'conflicting'};
 await assert.rejects(()=>importLegacyBatch(host,{...batch,connection},owner),/mismatch|conflict/);
 assert.deepEqual(f.records,before);
});

test('instance rebind rejects a mismatched legacy source and an obsolete Host owner fence',async t=>{
 const {f,batch,host,owner}=await imported(t),before=structuredClone(f.records);
 await assert.rejects(()=>importLegacyBatch(host,{...batch,sourceInstanceId:'another-source'},owner),/source_mismatch/);
 await assert.rejects(()=>importLegacyBatch(host,batch,{...owner,assertCurrent:async()=>{throw new Error('obsolete_instance');}}),/obsolete_instance/);
 assert.deepEqual(f.records,before);
});

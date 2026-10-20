import assert from 'node:assert/strict';
import test,{mock} from 'node:test';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import sharp from 'sharp';
import {paired,rpc,delivery} from './fixture.mjs';
import {createDotPlugin} from '../src/plugin-entrypoint.ts';
import {CONNECTION_KEY} from '../src/store.ts';

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};}

for(const change of ['reconnect','disconnect'])test(`${change} while a callback writer prepares prevents its POST`,async t=>{
 const f=await paired(t),entered=deferred(),release=deferred();
 await f.active.stop({reason:'test'});
 f.module=createDotPlugin({sendWebhook:async(url,headers,body,signal,beforeWrite)=>{
  entered.resolve();await release.promise;await beforeWrite?.();signal?.throwIfAborted();
  return f.sendWebhook(url,headers,body,signal);
 }});
 f.active=await f.module.start(f.host);const before=f.webhooks.length;
 const pending=f.active.actions.deliverMessage(delivery(f)).catch(error=>({error}));await entered.promise;
 await f.settings.actions[`dot.${change}`]({},undefined,f.owner);release.resolve();const result=await pending;
 assert.equal(f.webhooks.length,before,'revoked callback must receive no request');assert.ok(result.error);
});

for(const change of ['reconnect','disconnect'])test(`${change} during temporary PNG creation cannot retain a canonical original or metadata`,async t=>{
 const f=await paired(t);await f.active.actions.deliverMessage(delivery(f));const eventId=f.webhooks.at(-1).data.eventId;
 await rpc(f,'cat_cafe_dot_read_source',{event_id:eventId});
 const png=await sharp({create:{width:2,height:2,channels:4,background:'red'}}).png().toBuffer();
 const entered=deferred(),release=deferred(),writeFile=fs.writeFile;
 mock.method(fs,'writeFile',async(...args)=>{const result=await writeFile(...args);if(String(args[0]).endsWith('.tmp')){entered.resolve();await release.promise;}return result;});syncBuiltinESMExports();
 try{
  const pending=rpc(f,'cat_cafe_dot_publish_image',{event_id:eventId,publication_key:'revoked-file',png_base64:png.toString('base64')});
  await entered.promise;await f.settings.actions[`dot.${change}`]({},undefined,f.owner);release.resolve();const result=await pending;
  assert.deepEqual(await fs.readdir(f.host.dataPath+'/images'),[],'only uncommitted temporary bytes may be cleaned up');
  assert.equal([...f.records.keys()].filter(key=>key.startsWith('dot/image/')).length,0);
  assert.equal(f.sent.length,0);assert.ok(result.error);
 }finally{release.resolve();mock.restoreAll();syncBuiltinESMExports();}
});

test('verification transport also carries the original unpaired attempt fence',async t=>{
 const f=await paired(t),entered=deferred(),release=deferred();await f.active.stop({reason:'test'});
 f.module=createDotPlugin({sendWebhook:async(url,headers,body,signal,beforeWrite)=>{entered.resolve();await release.promise;await beforeWrite?.();return f.sendWebhook(url,headers,body,signal);}});
 f.settings=await f.module.settings(f.host);f.credentials=(await f.settings.actions['dot.reconnect']({},undefined,f.owner)).data;f.active=await f.module.start(f.host);
 const old=f.credentials,before=f.webhooks.length;
 const pending=f.active.actions['dot.rpc']({request:{method:'POST',path:'mcp',headers:{'x-dot-credential':old.credentialSecret},body:{jsonrpc:'2.0',id:1,method:'events/subscribe',params:{name:'dot.summoned',arguments:{attempt_id:old.attemptId,pairing_code:old.pairingCode},delivery:{mode:'webhook',url:'https://callbacks.example/dot',secret:'whsec_'+Buffer.alloc(32,1).toString('base64')}}}}});
 await entered.promise;await f.settings.actions['dot.reconnect']({},undefined,f.owner);release.resolve();const result=await pending;
 assert.equal(f.webhooks.length,before);assert.ok(result.body.error);
 assert.equal((await f.host.storage.get(CONNECTION_KEY)).value.subscription,null);
});

for(const change of ['reconnect','disconnect'])test(`${change} after PNG publication prevents the later metadata CAS`,async t=>{
 const f=await paired(t);await f.active.actions.deliverMessage(delivery(f));const eventId=f.webhooks.at(-1).data.eventId;
 await rpc(f,'cat_cafe_dot_read_source',{event_id:eventId});
 const png=await sharp({create:{width:2,height:2,channels:4,background:'blue'}}).png().toBuffer();
 const entered=deferred(),release=deferred(),link=fs.link;
 mock.method(fs,'link',async(...args)=>{const result=await link(...args);entered.resolve();await release.promise;return result;});syncBuiltinESMExports();
 try{
  const pending=rpc(f,'cat_cafe_dot_publish_image',{event_id:eventId,publication_key:'metadata-fence',png_base64:png.toString('base64')});
  await entered.promise;await f.settings.actions[`dot.${change}`]({},undefined,f.owner);release.resolve();const result=await pending;
  assert.equal([...f.records.keys()].filter(key=>key.startsWith('dot/image/')).length,0,'a later metadata write needs its own current authority');
  assert.equal(f.sent.length,0);assert.ok(result.error);
  assert.equal((await fs.readdir(f.host.dataPath+'/images')).length,1,'the original linked while authorized remains untouched');
 }finally{release.resolve();mock.restoreAll();syncBuiltinESMExports();}
});

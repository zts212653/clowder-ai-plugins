import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

// One process, two physical package/dependency graphs, and the actual default entrypoint.
const [firstRoot,secondRoot,dataPath,manifestJson]=process.argv.slice(2);
const manifest=JSON.parse(manifestJson),records=new Map();let revision=0;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64');
const newPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEElEQVR4nGNgYPj/H4LRGQCVhQv15UfOvQAAAABJRU5ErkJggg==','base64');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(png),'4ff6ab670a58c14270e034e2090d9a432caa263a14e0a25785386b0c12f880b5');
assert.equal(hash(newPng),'127a12ecc99fc39e4fd3490a9a69cb5d7ce0d48f685ccaaf41db39bd9d16dfd4');
const secret='a'.repeat(64),eventId='dot_evt_'+'b'.repeat(64),imageId='dot_img_'+'c'.repeat(64);
const connection={v:1,revision:1,ownerUserId:'owner',pluginInstanceId:'legacy-instance',agentKeyId:'legacy-key',credentialSecret:secret,
 attemptId:'legacy-attempt',pairingCode:'d'.repeat(32),pairingExpiresAt:1,pairedAt:1,pairedCallbackUrl:'https://callbacks.example/dot',
 subscription:{id:'sub',url:'https://callbacks.example/dot',secret:'webhook-secret',expiresAt:null,verifiedAt:1,previousSecret:null,rotationUntil:null},
 lastSourceReadAt:1,lastReplyAt:null,lastImageAt:null,revokedAt:null,testEventIds:[]};
const dispatch={eventId,ownerUserId:'owner',threadId:'thread',sourceMessageId:'source',dispatchInvocationId:'old-run',attemptId:connection.attemptId,
 agentKeyId:connection.agentKeyId,occurredAt:1,webhookAcknowledgedAt:1,sourceReadAt:1,replyMessageId:null,imagePublicationIds:[imageId],connectionTest:false};
const batch={version:1,ownerUserId:'owner',sourceInstanceId:connection.pluginInstanceId,connection,dispatches:[dispatch],images:[{
 metadata:{id:imageId,ownerUserId:'owner',threadId:'thread',eventId,publicationKey:'legacy-image',sha256:hash(png),byteSize:png.length,width:1,height:1,messageId:null,alt:'legacy PNG'},
 png_base64:png.toString('base64')}]};
const source={id:'source',threadId:'thread',userId:'owner',catId:null,content:'image request',timestamp:1,sourceRevision:'rev1'};
const sent=[];
function host(pluginInstanceId){return{pluginInstanceId,dataPath,config:{get:async()=>undefined},secrets:{get:async()=>undefined},log(){},
 storage:{get:async key=>structuredClone(records.get(key)),list:async()=>Object.fromEntries(records),
  set:async(key,value)=>{records.set(key,{value:structuredClone(value),revision:++revision});return{revision};},
  compareAndSet:async(key,expected,value)=>{if((records.get(key)?.revision??null)!==expected)return{applied:false};records.set(key,{value:structuredClone(value),revision:++revision});return{applied:true,revision};}},
 messaging:{subscribe:async()=>assert.fail('unexpected global subscription'),unsubscribe:async()=>{},get:async()=>source,
  send:async input=>{sent.push(input);return{threadId:input.threadId,messageId:'new-image-message'};}},
 threads:{get:async()=>({id:'thread'}),readMessages:async()=>[],getCats:async()=>({participants:[],routableNow:[]})}};}
function owner(h){return{kind:'owner-operation',userId:'owner',pluginInstanceId:h.pluginInstanceId,operationKey:'migration',actionId:'dot.import',requestId:'import',signal:new AbortController().signal,assertCurrent:async()=>{}};}
function rpc(active,method,params){return active.actions['dot.rpc']({request:{method:'POST',path:'mcp',headers:{'x-dot-credential':secret},body:{jsonrpc:'2.0',id:1,method,...params?{params}:{}}}});}
assert.notEqual(firstRoot,secondRoot);
const firstModule=(await import(pathToFileURL(join(firstRoot,'dist/plugin-entrypoint.js')))).default.create(manifest),firstHost=host('first-install');
const firstSettings=await firstModule.settings(firstHost);
assert.equal((await firstSettings.actions['dot.import'](batch,undefined,owner(firstHost))).data.pluginInstanceId,firstHost.pluginInstanceId);
await firstSettings.dispose();
const first=await firstModule.start(firstHost);assert.equal((await rpc(first,'tools/list')).status,200);
await first.stop({reason:'uninstall'});await firstModule.uninstall(firstHost);

const secondModule=(await import(pathToFileURL(join(secondRoot,'dist/plugin-entrypoint.js')))).default.create(manifest),secondHost=host('second-install');
const secondSettings=await secondModule.settings(secondHost);
const receipt=(await secondSettings.actions['dot.import'](batch,undefined,owner(secondHost))).data;
assert.equal(receipt.pluginInstanceId,secondHost.pluginInstanceId);assert.equal(receipt.duplicate,undefined);
await secondSettings.dispose();
assert.deepEqual(await readFile(join(dataPath,'images',imageId+'.png')),png);
assert.equal(records.get('dot/connection/v1').value.credentialSecret,secret);
const second=await secondModule.start(secondHost);
try{
 assert.equal((await rpc(second,'tools/list')).status,200);
 const image=await rpc(second,'tools/call',{name:'cat_cafe_dot_publish_image',arguments:{event_id:eventId,publication_key:'new-after-reinstall',png_base64:newPng.toString('base64'),alt:'new PNG'}});
 assert.equal(image.status,200);assert.equal(image.body.error,undefined,JSON.stringify(image.body));
 assert.equal(sent.length,1);
 const reference=sent[0].payload.elements.find(element=>element.kind==='media_ref').payload;
 assert.equal(reference.width,2);assert.equal(reference.height,3);assert.equal(reference.sha256,hash(newPng));
 const chunks=[];for await(const chunk of second.streams.read(reference.reference))chunks.push(chunk);
 assert.deepEqual(Buffer.concat(chunks),newPng);
 console.log(JSON.stringify({twoIndependentMaterializations:true,reimportedOriginal:true,oldCredential:true,newImagePublishedAndStreamed:true}));
}finally{await second.stop({reason:'test'});}

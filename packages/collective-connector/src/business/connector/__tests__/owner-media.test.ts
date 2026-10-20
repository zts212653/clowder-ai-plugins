import {test, expect} from 'vitest';
import {Readable} from 'node:stream';
import {createCollectiveMediaHttp} from '../../../collective-media-http.js';
import {ownerCaller} from '../../../../test/runtime-fixture.js';

function fixture() {
  let active = true, human = 'human-1', current = true;
  const calls: string[] = [];
  const constraint = () => ({serviceInstanceId:'service-1', collectiveId:'collective-1', connectionId:'connection-1', authorizedHumanId:human});
  const connector = {
    async readRetainedMediaAuthority(connection: string, owner: string) {
      if (connection !== 'connection-1' || owner !== 'local-owner' || !active) throw Object.assign(new Error('denied'), {statusCode:403});
      return constraint();
    },
    async readArtifactRegistrationContext() {calls.push('context'); return {current:null};},
    async registerArtifact(_connection: string, _owner: string, input: unknown) {calls.push('register'); return input;},
    async openArtifactMedia(_connection: string, _owner: string, _input: unknown, signal: AbortSignal) {
      signal.throwIfAborted(); calls.push('stream');
      return {descriptor:{contentRef:'content-1', ownerRevision:1, blobDigest:'sha256:'+'a'.repeat(64), ownerReceiptRef:'receipt-1',
        mediaType:'video/mp4', byteLength:5, status:206, start:1, end:3}, body:Readable.from([Buffer.from('123')])};
    },
  };
  const owner = {execute:async()=>({status:'error' as const,error:{code:'owner_unavailable' as const}}),media:{
    async listRetained(_input: unknown, authority: {reauthorize():Promise<unknown>}) {calls.push('list'); await authority.reauthorize(); return {items:[]};},
    async prepareShare(input: {contentRef:string;ownerRevision:number}, authority:{reauthorize():Promise<unknown>}) {
      calls.push('prepare'); await authority.reauthorize(); return {contentRef:input.contentRef,ownerRevision:input.ownerRevision,blobDigest:'sha256:'+'a'.repeat(64),mediaType:'image/png',ownerReceiptRef:'receipt-1'};
    },
  }};
  const handle=createCollectiveMediaHttp({connector:connector as never, owner:owner as never, assertActive(){if(!current)throw new Error('stopped');}});
  const invoke=(method:string,path:string,body?:unknown, user='local-owner', query:Record<string,unknown>={})=>{
    const caller={...ownerCaller(user,method),requestIdentity:{kind:'owner_http',pluginId:'official.collective-connector', pluginInstanceId:'installed-instance',
      userId:user, requestId:'request', transportRequestId:'transport',contributionId:'collective-media',method,declaredPath:path,path,bodyDigest:'digest',queryDigest:'query'}};
    return handle({request:{method,path,body,query,headers:{range:'bytes=1-3'},principal:{kind:'owner',id:user}}},undefined,caller as never);
  };
  return {invoke, handle, owner, connector, calls, revoke(){active=false;},changeHuman(){human='human-2';},stop(){current=false;}};
}
const base='connections/connection-1/artifacts/';
test('declared owner media reads retained items, prepares minimal receipt then registers remotely',async()=>{
  const f=fixture();
  expect((await f.invoke('GET',base+'retained-media')).status).toBe(200);
  const result=await f.invoke('POST',base+'share-media',{contentRef:'content-1',ownerRevision:1,title:'Media',sourceEventId:'event-1',requestId:'share-1'});
  expect(result.status).toBe(200);
  expect(f.calls).toEqual(['list','prepare','register']);
  expect(result.body).toMatchObject({receiptRef:'receipt-1',contentRef:'content-1',ownerRevision:1});
  expect(JSON.stringify(result.body)).not.toContain('local-owner');
});
test('only exact authenticated owner HTTP can reach retained owner services; foreign, legacy, native and stopped calls fail',async()=>{
  const f=fixture();
  expect((await f.invoke('GET',base+'retained-media',undefined,'foreign')).status).toBe(403);
  await expect(f.handle({request:{method:'GET',path:base+'retained-media',headers:{},principal:{kind:'owner',id:'local-owner'}}},undefined,ownerCaller('local-owner'))).rejects.toThrow();
  await expect(f.handle({},{} as never)).rejects.toThrow();
  f.stop();await expect(f.invoke('GET',base+'retained-media')).rejects.toThrow();
  expect(f.calls).toEqual([]);
});
test('share never registers after remote revocation or changed authority during the owner effect',async()=>{
  for(const change of ['revoke','human'] as const){
    const f=fixture();
    const original=f.owner.media.prepareShare;
    f.owner.media.prepareShare=async(input,authority)=>{const result=await original(input,authority);change==='revoke'?f.revoke():f.changeHuman();return result;};
    expect((await f.invoke('POST',base+'share-media',{contentRef:'content-1',ownerRevision:1,title:'Media',sourceEventId:'event-1',requestId:'share-1'})).status).toBe(403);
    expect(f.calls).not.toContain('register');
  }
});
test('media response retains range descriptor and streams bytes without JSON or whole-file buffering',async()=>{
  const f=fixture();
  const result=await f.invoke('GET',base+'artifact-1/media/1',undefined,'local-owner',{sourceEventId:'event-1'});
  expect(result.status).toBe(206);expect(result.headers).toMatchObject({'content-range':'bytes 1-3/5','content-length':'3','cache-control':'private, no-store'});
  const chunks:Buffer[]=[];for await(const chunk of result.body as Readable)chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toBe('123');
});

import {isDeepStrictEqual} from 'node:util';
import type {CollectiveArtifactOwnerPort, PluginOwnerHttpContext} from '@clowder-ai/plugin-sdk';
import {z} from 'zod';
import type {CollectiveConnector} from './business/connector/connector.js';
import {ConnectorTransportError} from './business/connector/service-client.js';
import {artifactIdentity} from './business/service/artifact-registration.js';
import {collectiveMediaDescriptorSchema, collectiveMediaResponseHeaders, collectiveRetainedMediaPageSchema,
  collectiveRetainedMediaRegistrationRequestSchema, collectiveRetainedMediaShareSchema} from './business/contracts/index.js';

const id = z.string().trim().min(1).max(256);
const requestSchema = z.object({request:z.object({
  method:z.enum(['GET','POST']),path:z.string().min(1).max(1024),query:z.record(z.unknown()).default({}),
  body:z.unknown().optional(),rawBody:z.unknown().optional(),
  headers:z.record(z.union([z.string(),z.array(z.string()),z.undefined()])).default({}),
  principal:z.object({kind:z.literal('owner'),id}).strict(),
}).strict()}).strict();
const shareReceiptSchema = z.object({contentRef:id,ownerRevision:z.number().int().positive().safe(),
  blobDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/),mediaType:z.enum(['image/png','video/mp4']),ownerReceiptRef:id}).strict();
const json = (status:number, body:unknown) => ({status,headers:{'content-type':'application/json','cache-control':'private, no-store'},body});

/** Business routing lives in the installed owner. Local identity is exclusively Host captured. */
export function createCollectiveMediaHttp(options:{
  readonly connector:Pick<CollectiveConnector,'readRetainedMediaAuthority'|'readArtifactRegistrationContext'|'registerArtifact'|'openArtifactMedia'>;
  readonly owner?:CollectiveArtifactOwnerPort;
  readonly assertActive:()=>void;
}) {
  return async (input:unknown, native?:unknown, context?:PluginOwnerHttpContext) => {
    if(native !== undefined || context?.kind !== 'owner-http-request' || !context.requestIdentity)
      throw new Error('Authenticated declared owner HTTP request required');
    const {request}=requestSchema.parse(input);
    const captured=context.requestIdentity;
    if(context.userId !== request.principal.id || captured.userId !== context.userId ||
      captured.pluginId !== 'official.collective-connector' || captured.pluginInstanceId !== context.pluginInstanceId ||
      captured.method !== request.method || captured.path !== request.path ||
      context.operation !== (request.method === 'GET' ? 'read':'write'))
      throw new Error('Owner HTTP request identity mismatch');
    let admitted=true;
    const current=async()=>{
      if(!admitted)throw new Error('Owner media invocation ended');
      context.signal.throwIfAborted();await context.assertCurrent();options.assertActive();context.signal.throwIfAborted();
    };
    await current();
    try {
      const match=/^connections\/([A-Za-z0-9_-]{1,240})\/artifacts\/(share-media\/context|retained-media|share-media|[^/]+\/media\/[^/]+)$/.exec(request.path);
      if(!match)return json(404,{error:'not_found'});
      const connectionId=match[1]!, action=match[2]!;
      const method=action==='retained-media'||action.includes('/media/')?'GET':'POST';
      if(request.method!==method)return json(405,{error:'method_not_allowed'});
      const initial=await options.connector.readRetainedMediaAuthority(connectionId,context.userId);
      await current();
      const reauthorize=async()=>{
        await current();
        const fresh=await options.connector.readRetainedMediaAuthority(connectionId,context.userId);
        await current();
        if(!isDeepStrictEqual(initial,fresh))throw new ConnectorTransportError('Remote owner authority changed',403,'ARTIFACT_ACCESS_DENIED');
        return fresh;
      };
      const finish=async(body:unknown)=>{await reauthorize();return json(200,body);};
      if(action==='share-media/context') {
        const selection=collectiveRetainedMediaRegistrationRequestSchema.omit({serviceInstanceId:true,collectiveId:true,connectionId:true}).parse(request.body);
        return await finish(await options.connector.readArtifactRegistrationContext(connectionId,context.userId,selection));
      }
      if(action==='retained-media') {
        const selection=z.object({after:id.optional()}).strict().parse(request.query);
        if(!options.owner?.media?.listRetained)return json(503,{error:'owner_unavailable'});
        return await finish(collectiveRetainedMediaPageSchema.parse(await options.owner.media.listRetained(selection,{reauthorize})));
      }
      if(action==='share-media') {
        const selection=collectiveRetainedMediaShareSchema.parse(request.body);
        if(!options.owner?.media?.prepareShare)return json(503,{error:'owner_unavailable'});
        const asset=shareReceiptSchema.parse(await options.owner.media.prepareShare({contentRef:selection.contentRef,ownerRevision:selection.ownerRevision,
          scope:{serviceInstanceId:initial.serviceInstanceId,collectiveId:initial.collectiveId,
            artifactId:artifactIdentity(initial.serviceInstanceId,initial.collectiveId,selection.contentRef),
            sourceEventId:selection.sourceEventId,custodyRevision:selection.expectedCustodyRevision??1}}, {reauthorize}));
        if(asset.contentRef!==selection.contentRef||asset.ownerRevision!==selection.ownerRevision)
          throw new Error('Retained media receipt does not match the selected object');
        await reauthorize();
        const {contentRef:_content,ownerRevision:_revision,...publicInput}=selection;
        return await finish(await options.connector.registerArtifact(connectionId,context.userId,{...publicInput,
          contentRef:asset.contentRef,ownerRevision:asset.ownerRevision,mediaType:asset.mediaType,blobDigest:asset.blobDigest,receiptRef:asset.ownerReceiptRef}));
      }
      const [artifactId,,revision]=action.split('/');
      const ownerRevision=z.coerce.number().int().positive().safe().parse(revision);
      const {sourceEventId}=z.object({sourceEventId:id}).strict().parse(request.query);
      const range=z.string().min(1).max(256).optional().parse(request.headers.range);
      const opened=await options.connector.openArtifactMedia(connectionId,context.userId,
        {artifactId:id.parse(artifactId),ownerRevision,sourceEventId,...(range?{range}:{})},context.signal);
      try {
        await reauthorize();
        const descriptor=collectiveMediaDescriptorSchema.parse(opened.descriptor);
        return {status:descriptor.status,headers:collectiveMediaResponseHeaders(descriptor),body:opened.body};
      } catch(error) {opened.body.destroy();throw error;}
    } catch(error) {
      await current();
      if(error instanceof z.ZodError)return json(400,{error:'invalid_request'});
      const failure=error as {statusCode?:number;code?:string};
      const status=failure.statusCode??(failure.code==='access_denied'?403:failure.code==='conflict'?409:503);
      return json([400,401,403,409,422,429].includes(status)?(status===401?403:status):503,
        {error:status===401||status===403?'access_denied':status===409?'conflict':status===400||status===422?'invalid_request':'owner_unavailable'});
    } finally {admitted=false;}
  };
}

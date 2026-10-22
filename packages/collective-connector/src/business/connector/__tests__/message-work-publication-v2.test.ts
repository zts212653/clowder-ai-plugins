import {expect, test, vi} from 'vitest';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {FeatureContext, PluginMessage, PluginTaskReadItem} from '@clowder-ai/plugin-sdk';
import {fixture} from './communication-work-custody.fixture.js';
import {collectiveEventSourceIdentity, parseCollectiveWorkResultFilePath} from '../../contracts/index.js';
import {collectiveSource} from '../../../collective-ingress-routing.js';
import {createCollectiveMessageWorkMaterials} from '../../../collective-message-work-materials.js';
import {createCollectiveMessageWorkArtifacts} from '../../../collective-message-work-artifacts.js';
import {readCollectiveWorkResultAttentionSource} from '../../../work-result-attention.js';
import {prepareWorkResultFilePublication} from '../work-result-publication.js';
import {memoryStorage} from '../../../../test/runtime-fixture.js';

/** Service/Connector/capture are production; Host message reads and scoped HMR delivery are explicit fixtures. */
async function setup(bytes = Buffer.from('# Actual document\n')) {
  const f = await fixture();
  try {
    // The ephemeral listener must be the fixture's canonical Service origin,
    // just as module activation configures its real Human auth redirect URI.
    f.store.configureHumanAuthRedirectUri(`${f.connection.serviceUrl}/api/auth/github/callback`);
    await f.connector.adoptWorkPolicy(f.connection.connectionId, 'local-owner', f.policy.revision);
    const accepted = await f.connector.acceptWork(f.source, f.agent, f.input);
    await f.connector.recordHostAdmission(f.connection.connectionId, {workId: accepted.workId,
      assignmentEventId: accepted.assignmentEventId!, operationRef: accepted.acceptance!.operationRef,
      grantRef: accepted.acceptance!.grantRef, grantRevision: accepted.acceptance!.grantRevision,
      disposition:{state:'admitted',receiptRef:'message:trigger'}});
    await f.connector.sync(f.connection.connectionId);
    const item = (await f.connector.listInbox(f.connection.connectionId)).find(row => row.event.eventId === accepted.assignmentEventId)!;
    const source = collectiveEventSourceIdentity(item.event)!;
    const work = await f.connector.readAssignedWork(source.connectionId, accepted.workId);
    const originalHref = '/uploads/doc-published.md';
    const trigger: PluginMessage = {id:'trigger',threadId:'private',userId:'local-owner',catId:null,
      content:item.event.body,source:collectiveSource(item.event, source),timestamp:1,sourceRevision:'trigger-v1',mentions:[]};
    const response: PluginMessage = {id:'response',threadId:'private',userId:'local-owner',catId:f.agent.catId,
      origin:'callback',content:'Document ready',timestamp:2,sourceRevision:'response-v1',mentions:[],
      extra:{causal:{kind:'invocation_reply',triggerMessageId:'trigger'},stream:{turnInvocationId:f.agent.sessionRef},
        rich:{v:1,blocks:[{id:'file',kind:'file',url:originalHref,mimeType:'text/markdown'}]}}};
    const messages = new Map([['trigger',trigger],['response',response]]);
    const task:PluginTaskReadItem = {id:'task',subjectKey:`collective-work:${source.connectionId}:${work.workId}`,kind:'work',status:'todo',
      title:'Collective Work',why:'Current Collective result',createdBy:'local-owner',createdAt:1,updatedAt:1,
      threadId:'private',ownerCatId:f.agent.catId,userId:'local-owner',entrustedWork:{revision:1,closure:{state:'open'},
        admission:{sourceRefs:['message:trigger'],authorityRef:`plugin-task-data:${createHash('sha256')
          .update(JSON.stringify(['installed-collective',`collective-work:${source.connectionId}:${work.workId}`])).digest('hex')}`}}};
    let denied=false, active=true;
    const context = {pluginInstanceId:'installed-collective',storage:memoryStorage(),messaging:{get:async(id:string)=>structuredClone(messages.get(id)??null)},
      tasks:{get:async()=>task,list:async()=>[task]},threads:{readMessages:async()=>[{id:'response',timestamp:2}]},
      streams:{async *read(){if(denied)throw new Error('HMR revoked');yield bytes;}}} as unknown as FeatureContext;
    const materials = createCollectiveMessageWorkMaterials(f.connector,context,()=>{if(!active)throw new Error('stopped');});
    const artifacts = createCollectiveMessageWorkArtifacts(context,materials);
    const binding = {auth:{userId:'local-owner',threadId:'private',catId:f.agent.catId},resultKey:'work:task',
      work:{workId:work.workId,revision:1,resultRevision:1,executionRevision:1,assignmentEventId:work.assignmentEventId},
      artifactRefs:[originalHref],async revalidate(){if(!active)throw new Error('stopped');}} as unknown as Parameters<typeof artifacts.readSelected>[0];
    const delivery={threadId:'private',envelope:{threadId:'private',messageId:'response',payload:{elements:[
      {elementId:'el_response_1',kind:'media_ref',payload:{type:'file',reference:'hmr_scoped'}}]}}};
    const capture=()=>materials.receive(delivery);
    return {...f,accepted,work,source,task,originalHref,messages,response,trigger,bytes,context,materials,artifacts,binding,capture,
      deny(){denied=true;},stop(){active=false;}};
  } catch(error){await f.close();throw error;}
}

test('doc source is rewritten to a distinct scoped v2 public sidecar, served by the actual Service',async()=>{
  const f=await setup();try{
    await f.capture();const selected=(await f.artifacts.readSelected(f.binding))!;
    expect(selected.file).toMatchObject({v:2,sourceHref:f.originalHref});
    expect(selected.file!.fileName).toMatch(/^cwork-[a-f0-9]{32}-[a-f0-9]{64}\.md$/);
    expect(selected.snapshot.textPublication?.v).toBe(2);
    const operation=await f.connector.prepareReply(f.source,'message:trigger','work:task',1,1,
      {revision:1,assignmentEventId:f.work.assignmentEventId!});
    await f.connector.submitReply(f.source,'message:trigger','work:task',operation.outboxId,`Read [document](${f.originalHref}).`,
      f.agent,selected.snapshot,1,{revision:1,assignmentEventId:f.work.assignmentEventId!},selected.file);
    const queued=JSON.parse(await readFile(join(f.root,'connector/collective-connector.json'),'utf8'));
    const wireFile=Object.values(queued.connections as Record<string,{outbox:Array<{workPurpose?:{resultFile?:unknown}}>}>).flatMap(row=>row.outbox).find(row=>row.workPurpose?.resultFile)?.workPurpose?.resultFile;
    expect(wireFile).not.toHaveProperty('sourceHref');
    const posted=vi.spyOn(f.store,'postAgentMessage');
    const sync = await f.connector.sync(f.source.connectionId);
    const outbox = await f.connector.prepareReply(f.source,'message:trigger','work:task',1,1,
      {revision:1,assignmentEventId:f.work.assignmentEventId!});
    expect(outbox, JSON.stringify({outbox, sync})).toMatchObject({status:'accepted'});
    const ready=await f.connector.readAssignedWork(f.source.connectionId,f.work.workId);
    const events=await f.store.listEventsForHuman(f.owner.sessionToken,f.connection.collectiveId);
    const result=events.find(row=>row.eventId===ready.resultEventId)!;
    expect(result.body).not.toContain(f.originalHref);
    const href=/\]\((https?:[^)]+)\)/.exec(result.body)![1]!;
    const response=await fetch(href,{headers:{authorization:`Bearer ${f.owner.sessionToken}`}});
    expect(response.status).toBe(200);expect(Buffer.from(await response.arrayBuffer())).toEqual(f.bytes);
    expect(href).not.toContain('doc-published');
    const state=JSON.parse(await readFile(join(f.root,'service/collective-service.json'),'utf8'));
    const record=Object.values(state.workResultFiles)[0];expect(record).not.toHaveProperty('sourceHref');
    const [credential,wire,origin]=posted.mock.calls[0]!;
    expect((wire as {workResultFile:unknown}).workResultFile).not.toHaveProperty('sourceHref');
    expect((await f.store.postAgentMessage(credential,wire,origin)).eventId).toBe(result.eventId);
    const file=(wire as {workResultFile:Record<string,unknown>}).workResultFile;
    await expect(f.store.postAgentMessage(credential,{...(wire as object),workResultFile:{...file,sourceHref:f.originalHref}},origin)).rejects.toThrow();
    const binding={serviceInstanceId:f.connection.serviceInstanceId,collectiveId:f.connection.collectiveId,connectionId:f.connection.connectionId,resultEventId:result.eventId,workResultFile:file};
    expect(await f.store.bindAcceptedWorkResultFile(credential,binding)).toMatchObject({resultEventId:result.eventId,fileId:file.fileId});
    await expect(f.store.bindAcceptedWorkResultFile(credential,{...binding,workResultFile:{...file,fileId:'wrf_'+'a'.repeat(64)}})).rejects.toThrow();
    const latest=await f.store.listEventsForHuman(f.owner.sessionToken,f.connection.collectiveId);
    expect(latest.filter(row=>row.eventId===result.eventId)).toHaveLength(1);
  }finally{await f.close();}
});

test('v2 refuses absent capture, changed message/trigger and another Task or result round',async()=>{
  const f=await setup();try{
    await expect(f.artifacts.readSelected(f.binding)).rejects.toThrow();
    await f.capture();
    const selected=(await f.artifacts.readSelected(f.binding))!;
    const prepare=(source=selected.file!,snapshot=selected.snapshot,owner='local-owner')=>prepareWorkResultFilePublication({
      outboxId:'outbox-v2',serviceUrl:f.connection.serviceUrl,body:`[document](${f.originalHref})`,source,artifactSnapshot:snapshot,localOwnerUserId:owner});
    expect(()=>prepare({...selected.file!,fileName:'cwork-'+ 'a'.repeat(32)+'-'+ 'b'.repeat(64)+'.md'})).toThrow();
    expect(()=>prepare(selected.file!,{...selected.snapshot,taskRef:'task:work:foreign'})).toThrow();
    expect(()=>prepare(selected.file!,{...selected.snapshot,textPublication:{...selected.snapshot.textPublication!,resultRevision:2}})).toThrow();
    expect(()=>prepare({...selected.file!,contentDigest:'sha256:'+ 'b'.repeat(64)})).toThrow();
    expect(()=>prepare(selected.file!,selected.snapshot,'foreign-owner')).toThrow();
    f.messages.set('response',{...f.response,sourceRevision:'changed'});await expect(f.artifacts.readSelected(f.binding)).rejects.toThrow();
    f.messages.set('response',f.response);f.messages.set('trigger',{...f.trigger,sourceRevision:'changed'});
    await expect(f.artifacts.readSelected(f.binding)).rejects.toThrow();
  }finally{await f.close();}
});

test('ordinary upload without publisher linkage, revoked HMR, oversized and nonUTF8 bytes never become v2',async()=>{
  for(const mode of ['no-receipt','revoked','large','binary'] as const){
    const f=await setup(mode==='large'?Buffer.alloc(65537,65):mode==='binary'?Buffer.from([255]):undefined);
    try{
      if(mode==='no-receipt')f.messages.set('response',{...f.response,extra:{rich:f.response.extra!.rich}});
      if(mode==='revoked')f.deny();
      if(mode==='revoked')await expect(f.capture()).rejects.toThrow('HMR revoked');else await f.capture();
      await expect(f.artifacts.readSelected(f.binding)).rejects.toThrow();
    }finally{await f.close();}
  }
});

test('retained media fresh authority uses the authenticated endpoint and refuses remote revocation',async()=>{
  const f=await fixture();try{
    const authority=await f.connector.readRetainedMediaAuthority(f.connection.connectionId,'local-owner');
    expect(authority).toEqual({serviceInstanceId:f.connection.serviceInstanceId,collectiveId:f.connection.collectiveId,
      connectionId:f.connection.connectionId,authorizedHumanId:f.owner.human.humanId});
    await expect(f.connector.readRetainedMediaAuthority(f.connection.connectionId,'foreign')).rejects.toThrow();
    await f.connector.revoke(f.connection.connectionId);
    await expect(f.connector.readRetainedMediaAuthority(f.connection.connectionId,'local-owner')).rejects.toThrow();
  }finally{await f.close();}
});

test('accepted legacy metadata is recovered from its original doc capture without a second result or Host cwork read',async()=>{
  const f=await setup();try{
    await f.capture();const selected=(await f.artifacts.readSelected(f.binding))!;
    const {textPublication:_seal,...metadata}=selected.snapshot;
    const operation=await f.connector.prepareReply(f.source,'message:trigger','work:task',1,1,
      {revision:1,assignmentEventId:f.work.assignmentEventId!});
    await f.connector.submitReply(f.source,'message:trigger','work:task',operation.outboxId,`[document](${f.originalHref})`,
      f.agent,metadata,1,{revision:1,assignmentEventId:f.work.assignmentEventId!});
    await f.connector.sync(f.source.connectionId);
    const before=await f.connector.readAssignedWork(f.source.connectionId,f.work.workId);
    expect(before.resultEventId).toBeTruthy();
    const repair=()=>f.connector.reconcileAcceptedWorkResultFiles(f.source.connectionId,
      (scope,publication)=>f.artifacts.sealAccepted(scope,publication,async()=>{}));
    const bound=vi.spyOn(f.store,'bindAcceptedWorkResultFile');
    expect(await repair()).toEqual({published:1});
    const [credential,wire]=bound.mock.calls[0]!;
    expect((wire as {workResultFile:unknown}).workResultFile).toMatchObject({v:1,sourceHref:f.originalHref});
    const request=wire as {workResultFile:Record<string,unknown>};
    await expect(f.store.bindAcceptedWorkResultFile(credential,{...request,workResultFile:{...request.workResultFile,sourceHref:'/uploads/doc-foreign.md'}})).rejects.toThrow();
    expect(await repair()).toEqual({published:0});
    const after=await f.connector.readAssignedWork(f.source.connectionId,f.work.workId);
    expect(after.resultEventId).toBe(before.resultEventId);expect(after.resultRevision).toBe(before.resultRevision);
    const events=await f.store.listEventsForHuman(f.owner.sessionToken,f.connection.collectiveId);
    const body=events.find(row=>row.eventId===before.resultEventId)!.body;
    expect(body).not.toContain(f.originalHref);expect(body).toContain('/cwork-');
  }finally{await f.close();}
});

test('result attention is owned by the installed Work feature and retires on artifact drift or public acceptance',async()=>{
  const f=await setup();try{
    await f.capture();const selected=(await f.artifacts.readSelected(f.binding))!;
    Object.assign(f.task,{entrustedWork:{...f.task.entrustedWork!,artifactRefs:[f.originalHref]}});
    const operation=await f.connector.prepareReply(f.source,'message:trigger','work:task',1,1,
      {revision:1,assignmentEventId:f.work.assignmentEventId!});
    await f.connector.submitReply(f.source,'message:trigger','work:task',operation.outboxId,
      `[document](${f.originalHref})`,f.agent,selected.snapshot,1,
      {revision:1,assignmentEventId:f.work.assignmentEventId!},selected.file);
    await f.connector.sync(f.source.connectionId);

    const current=async()=>{};
    const ready=await f.connector.readAssignedWork(f.source.connectionId,f.work.workId);
    const attention=await readCollectiveWorkResultAttentionSource(
      f.connector,f.context,f.artifacts,'local-owner',current);
    expect(attention.state).toMatchObject({coverage:'current_f290_collective_work_results',status:'available',exhaustiveness:'complete'});
    expect(attention.items).toHaveLength(1);
    expect(attention.items[0]).toMatchObject({eligible:true,
      producer:{producerId:'f290.collective_work_result',revision:ready.revision},
      taskRef:{subjectRef:'task:work:task',observedRevision:1},kind:'judgment',reasonCode:'collective_result_ready',
      action:{actionRef:expect.stringContaining(`workId=${f.work.workId}`),expectedProducerRevision:ready.revision}});

    Object.assign(f.task,{entrustedWork:{...f.task.entrustedWork!,artifactRefs:['/uploads/doc-changed.md']}});
    expect((await readCollectiveWorkResultAttentionSource(
      f.connector,f.context,f.artifacts,'local-owner',current)).items).toEqual([]);
    Object.assign(f.task,{entrustedWork:{...f.task.entrustedWork!,artifactRefs:[f.originalHref]}});
    await f.store.acceptCollectiveWorkResult(f.owner.sessionToken,{
      serviceInstanceId:f.connection.serviceInstanceId,collectiveId:f.connection.collectiveId,
      requestId:'accept-attention-result',workId:ready.workId,expectedRevision:ready.revision,
      resultEventId:ready.resultEventId!,resultRevision:ready.resultRevision??1});
    expect((await readCollectiveWorkResultAttentionSource(
      f.connector,f.context,f.artifacts,'local-owner',current)).items).toEqual([]);
  }finally{await f.close();}
});

test('a completed Work result promotes its existing bytes through the canonical owner without another result or acceptance',async()=>{
  const f=await setup(Buffer.from('# Original result\n\nKeep these exact bytes.\n'));try{
    await f.capture();const selected=(await f.artifacts.readSelected(f.binding))!;
    const operation=await f.connector.prepareReply(f.source,'message:trigger','work:task',1,1,
      {revision:1,assignmentEventId:f.work.assignmentEventId!});
    await f.connector.submitReply(f.source,'message:trigger','work:task',operation.outboxId,
      `[document](${f.originalHref})`,f.agent,selected.snapshot,1,
      {revision:1,assignmentEventId:f.work.assignmentEventId!},selected.file);
    await f.connector.sync(f.source.connectionId);
    const ready=await f.connector.readAssignedWork(f.source.connectionId,f.work.workId);
    const completed=await f.store.acceptCollectiveWorkResult(f.owner.sessionToken,{
      serviceInstanceId:f.connection.serviceInstanceId,collectiveId:f.connection.collectiveId,
      requestId:'accept-original-result',workId:ready.workId,expectedRevision:ready.revision,
      resultEventId:ready.resultEventId!,resultRevision:ready.resultRevision??1});
    expect(completed).toMatchObject({lifecycle:'completed',status:'completed'});
    const result=(await f.store.listEventsForHuman(f.owner.sessionToken,f.connection.collectiveId))
      .find(row=>row.eventId===ready.resultEventId)!;
    const href=/\]\((https?:[^)]+)\)/.exec(result.body)?.[1];
    const address=href?parseCollectiveWorkResultFilePath(new URL(href).pathname):undefined;
    expect(address).toBeTruthy();

    const seen: unknown[]=[];
    f.connector.setArtifactOwner({
      async execute(){return {status:'error',error:{code:'unsupported_operation'}};},
      async publish(ownerOperation,authority){
        expect(await authority.reauthorize()).toEqual(ownerOperation.publication);
        seen.push(ownerOperation);
        const publication=ownerOperation.publication;
        const scope={kind:'collective-artifact',serviceInstanceId:publication.serviceInstanceId,
          collectiveId:publication.collectiveId,artifactId:publication.artifactId,contentRef:publication.contentRef,
          sourceEventId:publication.sourceEventId,publishedByHumanId:publication.humanId};
        const scopeRef=`collective-owner:${createHash('sha256').update(JSON.stringify(scope)).digest('hex')}`;
        return {status:'ok',ownerDecisionRef:publication.publicationId,value:{receipt:{
          receiptId:`receipt:${publication.publicationId}`,contentRef:publication.contentRef,
          previousOwnerRevision:0,ownerRevision:1,blobDigest:publication.blobDigest,
          actor:{kind:'human',actorId:publication.humanId},operationId:publication.publicationId,outboxSequence:1,
          operationContext:{kind:'collective-artifact:publish',requestDigest:publication.requestDigest,
            actorHumanId:publication.humanId,scopeRef,custodyRevision:1,dispositionId:publication.publicationId}}}};
      },
    });
    let settled=false;
    const promotion=f.store.promoteWorkResultArtifact(f.owner.sessionToken,{
      serviceInstanceId:f.connection.serviceInstanceId,collectiveId:f.connection.collectiveId,fileId:address!.fileId,
    }).finally(()=>{settled=true;});
    for(let tick=0;tick<40&&!settled;tick+=1){await f.connector.sync(f.source.connectionId);if(!settled)await new Promise(resolve=>setTimeout(resolve,5));}
    const published=await promotion;
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({bytesBase64:f.bytes.toString('base64'),publication:{
      sourceEventId:ready.sourceEventId,workId:ready.workId,title:f.input.title,blobDigest:selected.file!.contentDigest}});
    expect(published).toMatchObject({status:'published',artifact:{workId:ready.workId,
      sourceEventId:ready.sourceEventId,title:f.input.title,versions:[{blobDigest:selected.file!.contentDigest}]}});
    expect(await f.store.promoteWorkResultArtifact(f.owner.sessionToken,{
      serviceInstanceId:f.connection.serviceInstanceId,collectiveId:f.connection.collectiveId,fileId:address!.fileId,
    })).toEqual(published);
    expect(seen).toHaveLength(1);
    expect(await f.connector.readAssignedWork(f.source.connectionId,f.work.workId)).toMatchObject({
      lifecycle:'completed',revision:completed.revision,resultEventId:ready.resultEventId,resultRevision:ready.resultRevision});
    expect((await f.store.listEventsForHuman(f.owner.sessionToken,f.connection.collectiveId))
      .filter(row=>row.eventId===ready.resultEventId)).toHaveLength(1);
  }finally{await f.close();}
});

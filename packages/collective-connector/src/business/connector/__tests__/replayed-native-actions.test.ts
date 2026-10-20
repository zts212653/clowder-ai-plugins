import {expect,test,vi} from 'vitest';
import {join} from 'node:path';
import {publicSourceFixture} from './public-source-caller.fixture.js';
import {openCollectiveContextReferences} from '../../../collective-context-refs.js';
import {createCollectivePublicNativeActions} from '../../../collective-public-native-context.js';

async function setup(){
  const f=await publicSourceFixture({methods:['collective.context.current','collective.work.suggest-project','collective.artifact.command'],invocationId:'fixture-running-turn'});
  try{
    const references=await openCollectiveContextReferences(join(f.root,'replay-refs'),()=>{});
    const actions=createCollectivePublicNativeActions({connector:f.connector,sourceCaller:f.sourceCaller,references});
    await f.admit();
    const invoke=(method:string,input:unknown,action=f.action)=>Promise.resolve(actions[method]!(input,action)) as Promise<any>;
    return {...f,invoke,current:()=>invoke('collective.context.current',{})};
  }catch(error){await f.close();throw error;}
}

test('Project native suggestion uses the actual source-bound Project and remains pending Human decision',async()=>{
  const f=await setup();try{
    const coords={serviceInstanceId:f.connection.serviceInstanceId,collectiveId:f.connection.collectiveId};
    const source=await f.store.postHumanMessage(f.serviceOwner.sessionToken,{...coords,clientEventId:'prior-work-source',location:{channelId:'general'},recipient:{kind:'channel'},body:'Complete the existing Work'});
    const proposal=await f.store.proposeCollectiveWork(f.serviceOwner.sessionToken,{...coords,requestId:'prior-work-proposal',sourceEventId:source.eventId,title:'Existing Work',intendedOutcome:'Complete the existing outcome'});
    const work=await f.store.commitCollectiveWork(f.serviceOwner.sessionToken,{...coords,requestId:'prior-work-commit',workId:proposal.workId,expectedRevision:proposal.revision,assignment:{connectionId:f.connection.connectionId,catId:f.agent.catId,participationRevision:1}});
    const project=await f.store.createCollectiveProject(f.serviceOwner.sessionToken,{...coords,requestId:'native-project',channelId:'general',title:'Project',purpose:'Complete the Work'});
    const linked=await f.store.setCollectiveRoadmapWorks(f.serviceOwner.sessionToken,{...coords,requestId:'native-project-link',roadmapId:project.roadmapId,expectedRevision:project.revision,workIds:[work.workId]});
    const context=await f.current(), matter=context.workSourceContext.matters.find((row:{workId:string})=>row.workId===work.workId);
    const input={contextRef:context.contextRef,projectRef:matter.projectContext.projects[0].projectRef,
      prerequisiteForWorkRef:matter.workRef,title:'Verify dependency',intendedOutcome:'Return the verified outcome'};
    const result=await f.invoke('collective.work.suggest-project',input);
    expect(result).toMatchObject({disposition:'pending_human_decision',lifecycle:'proposed',projectSuggestion:{roadmapId:project.roadmapId,roadmapRevision:linked.revision,prerequisiteForWorkId:work.workId}});
    const propose=vi.spyOn(f.connector,'proposeWork');
    await expect(f.invoke('collective.work.suggest-project',{...input,projectRef:input.projectRef+'!'})).rejects.toThrow();
    await expect(f.invoke('collective.work.suggest-project',{...input,connectionId:'forged'})).rejects.toMatchObject({code:'INVALID_COLLECTIVE_REQUEST'});
    await f.store.setCollectiveRoadmapWorks(f.serviceOwner.sessionToken,{...coords,requestId:'change-project',roadmapId:project.roadmapId,expectedRevision:linked.revision,workIds:[]});
    await expect(f.invoke('collective.work.suggest-project',input)).rejects.toMatchObject({code:'WORK_REVISION_CONFLICT'});
    expect(propose).not.toHaveBeenCalled();
  }finally{vi.restoreAllMocks();await f.close();}
});

test('Artifact native command freezes the authenticated source, declared target and invocation; it never accepts apply or body identity',async()=>{
  const f=await setup();try{
    // The owner relay is tested against a real Service separately. Here its read result is the explicit seam.
    vi.spyOn(f.connector,'readArtifactContext').mockResolvedValue({status:'available',requests:[{
      artifactId:'artifact-selected',title:'Document',contentRef:'content-1',sourceEventId:f.source.eventId,
      requestEventId:f.source.eventId,ownerRevision:1,blobDigest:'sha256:'+'a'.repeat(64),annotationIds:[],expectedReviewRevision:1,
    }]} as never);
    const request=vi.spyOn(f.connector,'requestArtifactForAgent').mockResolvedValue({text:'Owner bytes'});
    const context=await f.current(), input={contextRef:context.contextRef,command:{kind:'read',artifactId:'artifact-selected'}};
    expect(await f.invoke('collective.artifact.command',input)).toEqual({text:'Owner bytes'});
    expect(request).toHaveBeenCalledWith(f.source,f.agent,expect.objectContaining({artifactId:'artifact-selected',sourceEventId:f.source.eventId,ownerRevision:1,action:'read'}));
    request.mockClear();
    await expect(f.invoke('collective.artifact.command',{...input,command:{kind:'apply',artifactId:'artifact-selected'}})).rejects.toMatchObject({code:'INVALID_COLLECTIVE_REQUEST'});
    await expect(f.invoke('collective.artifact.command',{...input,command:{...input.command,userId:'forged'}})).rejects.toMatchObject({code:'INVALID_COLLECTIVE_REQUEST'});
    await expect(f.invoke('collective.artifact.command',{...input,command:{...input.command,artifactId:'foreign'}})).rejects.toMatchObject({code:'ARTIFACT_ACCESS_DENIED'});
    await expect(f.invoke('collective.artifact.command',{...input,contextRef:context.contextRef+'!'})).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    f.expire();await expect(f.invoke('collective.artifact.command',input)).rejects.toThrow('Caller expired');
    expect(request).not.toHaveBeenCalled();
  }finally{vi.restoreAllMocks();await f.close();}
});

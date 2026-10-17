import {expect,test} from 'vitest';
import type {AssignedWorkAuthorityScope,CollectiveConnector} from '../connector.js';
import type {CollectiveWorkArtifactBinding,createCollectiveWorkArtifacts} from '../../../collective-work-artifacts.js';
import {readPreviousCollectiveWorkArtifact as sourceReader} from '../../../collective-work-history.js';
const readPrevious: typeof sourceReader=process.env.WORK_ARTIFACT_PUBLICATION_COMPILED==='1'
 ? (await import(new URL('../../../../dist/collective-work-history.js',import.meta.url).href)).readPreviousCollectiveWorkArtifact : sourceReader;

// Controlled authority frame; the separate actual Service/Registry/Host probe
// establishes where this frame comes from. Tests observe witness selection and
// fence ordering, never claim that an outbox or private byte record grants Work.
function fixture() {
 let inside=false,reads=0,witnesses=0,changeAfterRead=false;
 const publication={serviceInstanceId:'svc',collectiveId:'col',connectionId:'conn',authorizedHumanId:'human',
  localOwnerUserId:'owner',assignmentEventId:'assignment',channelId:'general',catId:'cat',taskRef:'task:work:task',taskRevision:1,
  workId:'work',resultEventId:'result1',resultRevision:1,executionRevision:1,
  artifactSnapshot:{taskRef:'task:work:task',taskRevision:1,artifactRef:'collective-artifact:'+ 'a'.repeat(64),
   artifactRevision:'revision',completenessRef:'publication',previewRef:'thread',openInWorkspaceRef:'thread',textPublication:{v:1 as const,
   taskId:'task',resultRevision:1,executionRevision:1,executionRef:'message:execution1',sourceMessageId:'publication',
   sourceMessageRevision:'revision',triggerMessageId:'trigger',publisherCatId:'cat',invocationId:'old-turn',
   item:{kind:'content-block' as const,index:0},contentDigest:'sha256:'+ 'b'.repeat(64),byteLength:4,mediaType:'text/plain' as const}}};
 const frame={connection:{authorityStatus:'connected',authorizedHumanId:'human'},hostRoute:{localOwnerUserId:'owner'},
  work:{workId:'work',assignmentEventId:'assignment',assignment:{catId:'cat',connectionId:'conn'},accountableHumanId:'human',
   lifecycle:'in_progress',executionAuthority:{revision:2,resultRevision:2},history:[{action:'result_returned',eventId:'result1',resultRevision:1}]},
  resultPublications:[publication]};
 const binding={auth:{userId:'owner',catId:'cat',task:{taskRef:'task:work:task'}},source:{connectionId:'conn'},
  work:{workId:'work',assignmentEventId:'assignment',executionRevision:2,resultRevision:2},
  async revalidate(){if(inside)throw Error('Do not reenter the held connection fence');}} as unknown as CollectiveWorkArtifactBinding;
 const connector={async withSynchronizedAssignedWorkAuthority(_connection:string,_assignment:string,consume:(scope:AssignedWorkAuthorityScope)=>Promise<unknown>){
   inside=true;witnesses++;try{return await consume(frame as unknown as AssignedWorkAuthorityScope);}finally{inside=false;}}} as unknown as CollectiveConnector;
 const artifacts={async readAccepted(_binding: unknown, _publication: unknown, beforeReturn?: () => Promise<void>){if(inside)throw Error('Private reads must occur outside the connection fence');reads++;
   if(changeAfterRead)frame.resultPublications=[];
   await beforeReturn?.();
   return {state:'available',text:'data',resultEventId:'result1'};}} as unknown as ReturnType<typeof createCollectiveWorkArtifacts>;
 return {publication,frame,binding,connector,artifacts,get reads(){return reads;},get witnesses(){return witnesses;},changeAfterRead(){changeAfterRead=true;}};
}
test('one prior accepted witness reads outside the fence and is rechecked before returning content',async()=>{
 const f=fixture();expect(await readPrevious(f.connector,f.binding,f.artifacts)).toMatchObject({state:'available',text:'data'});
 expect(f.reads).toBe(1);expect(f.witnesses).toBe(2);
});
test('missing, mismatched and duplicate accepted witnesses return unavailable before private reads',async()=>{
 for(const kind of ['missing','mismatch','duplicate']){
  const f=fixture();f.frame.resultPublications=kind==='missing'?[]:kind==='mismatch'?[{...f.publication,resultEventId:'foreign'}]:[f.publication,f.publication];
  expect(await readPrevious(f.connector,f.binding,f.artifacts)).toMatchObject({state:'unavailable',code:'UNSEALED_RESULT'});expect(f.reads).toBe(0);
 }
});
test('legacy uploaded artifact is metadata-only and never opened via a path or URL',async()=>{
 const f=fixture();f.publication.artifactSnapshot.artifactRef='/uploads/cwork-old.md';
 expect(await readPrevious(f.connector,f.binding,f.artifacts)).toMatchObject({state:'unavailable',code:'LEGACY_ARTIFACT_UNAVAILABLE'});
 expect(f.reads).toBe(0);
});
test('a witness removed during private reading cannot authorize the returned text',async()=>{
 const f=fixture();f.changeAfterRead();await expect(readPrevious(f.connector,f.binding,f.artifacts)).rejects.toMatchObject({code:'WORK_ARTIFACT_UNAVAILABLE'});
 expect(f.reads).toBe(1);expect(f.witnesses).toBe(2);
});

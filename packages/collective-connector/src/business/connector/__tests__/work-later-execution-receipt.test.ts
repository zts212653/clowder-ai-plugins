import {expect, test} from "vitest";
import type {PluginMessage, PluginStorageEntry, PluginTaskReadItem, PluginTaskAdmissionInput,PluginNativeTaskContext,PluginActionContext} from "@clowder-ai/plugin-sdk";
import {collectiveEventSourceIdentity} from "../../contracts/index.js";
import {collectiveSource} from "../../../collective-ingress-routing.js";
import {createCollectiveWorkAdmissionCaller as sourceCaller} from "../../../collective-work-admission-caller.js";
import {createCollectiveAgentWorkContextCaller} from "../../../agent-work-context-caller.js";
import {readWorkFirstReceipt,manualWorkFirstReceiptKey} from "../../../owner-work-first-receipt.js";
import {fixture} from "./communication-work-custody.fixture.js";
const compiledCaller = process.env.WORK_LATER_CALLER_MODULE ?? (process.env.OWNER_WORK_CALLER_COMPILED === "1"
  ? new URL("../../../../dist/collective-work-admission-caller.js",import.meta.url).href : undefined);
const createCaller: typeof sourceCaller = compiledCaller ? (await import(compiledCaller)).createCollectiveWorkAdmissionCaller : sourceCaller;

// Actual Service and Connector; Task/message/private-storage ports are explicit
// fixtures. The separate compiled Host probe covers protected execution effects.
async function setup(bootstrap = false, humanBirth = false) {
  const f=await fixture();
  await f.connector.adoptWorkPolicy(f.connection.connectionId,"local-owner",f.policy.revision);
  let work: Awaited<ReturnType<typeof f.connector.acceptWork>>;
  if(humanBirth) {
    const proposed=await f.store.proposeCollectiveWork(f.owner.sessionToken,{serviceInstanceId:f.connection.serviceInstanceId,
      collectiveId:f.connection.collectiveId,sourceEventId:f.source.eventId,requestId:"later-human-propose"});
    work=await f.store.commitCollectiveWork(f.owner.sessionToken,{serviceInstanceId:f.connection.serviceInstanceId,
      collectiveId:f.connection.collectiveId,workId:proposed.workId,expectedRevision:proposed.revision,requestId:"later-human-commit",
      assignment:{connectionId:f.connection.connectionId,catId:f.agent.catId,participationRevision:1}});
    const route=(await f.connector.getHostRoute(f.connection.connectionId))!,key=`${f.connection.authorizedHumanId}:${f.agent.catId}`;
    await f.connector.setHostRoute(f.connection.connectionId,{localOwnerUserId:route.localOwnerUserId,
      defaultIngressThreadId:route.defaultIngressThreadId,humanNotificationThreadId:route.humanNotificationThreadId,
      agentRoutes:{...route.agentRoutes,[key]:{...route.agentRoutes[key]!,standingWork:{channelIds:["general"],requestingHumanIds:[f.owner.human.humanId],expiresAt:null}}}},route.revision);
  } else work=await f.connector.acceptWork(f.source,f.agent,f.input);
  await f.connector.sync(f.connection.connectionId);
  const records=new Map<string,PluginStorageEntry>(), messages=new Map<string,PluginMessage>();
  let version=0,aggregate=1,created=false; const prepares: PluginTaskAdmissionInput[]=[]; const dispatches: string[]=[];
  const storage={get:async(key:string)=>structuredClone(records.get(key)),compareAndSet:async(key:string,expected:number|null,value:unknown)=>{
    if((records.get(key)?.revision??null)!==expected)return {applied:false};
    records.set(key,{revision:++version,value:structuredClone(value)});return {applied:true,revision:version};}};
  async function publish(eventId:string,id:string) {
    const item=(await f.connector.listInbox(f.connection.connectionId)).find(x=>x.event.eventId===eventId)!;
    const identity=collectiveEventSourceIdentity(item.event)!;
    const routeRevision=(await f.connector.getHostRoute(f.connection.connectionId))!.revision;
    await f.connector.beginInboxRouting(f.connection.connectionId,eventId,routeRevision);
    await f.connector.completeInboxRouting(f.connection.connectionId,eventId,routeRevision,{kind:"thread_message",threadId:"channel",messageId:id,catId:identity.catId});
    messages.set(id,{id,threadId:"channel",userId:"local-owner",catId:null,content:item.event.body,
      source:collectiveSource(item.event,identity),timestamp:1,mentions:[],sourceRevision:"revision:"+id});
    return {ownerUserId:"local-owner",identity,sourceMessageId:id,workId:work.workId,destination:{kind:"derived_from_source" as const}};
  }
  const firstSelection=await publish(work.assignmentEventId!,"first");
  const task=():PluginTaskReadItem=>({id:"task",kind:"work",userId:"local-owner",threadId:"child",ownerCatId:f.agent.catId,
    title:work.title,why:work.intendedOutcome,subjectKey:null,status:"todo",createdBy:"system",createdAt:1,updatedAt:1,
    entrustedWork:{revision:aggregate,admission:{sourceRefs:["message:first"]},closure:{state:"open"}}});
  const tasks={get:async()=>created?task():null,listByKind:async()=>created?[task()]:[],
    prepareEntrusted:async(input:PluginTaskAdmissionInput)=>{prepares.push(input);created=true;
      if(input.subject.kind==="continue")expect(input.subject).toEqual({kind:"continue",taskRef:"task:work:task",expectedRevision:aggregate});
      return {result:"admitted" as const,taskRef:"task:work:task",taskRevision:aggregate,threadId:"child",admissionRef:"message:admission",
        executionRef:input.subject.kind==="continue"?"message:second-execution":"message:first-execution"};},
    dispatchEntrusted:async(input:{executionRef:string})=>{dispatches.push(input.executionRef);
      return {messageRef:input.executionRef,entryId:input.executionRef,status:"queued" as const};}};
  const threads={get:async(id:string)=>({id,title:"Work",deepLinkUrl:"https://fixture/"+id,createdAt:1,lastActiveAt:1,preferredCats:[],featureRefs:[]}),
    ensureByKey:async()=>({id:"child",title:"Work",deepLinkUrl:"https://fixture/child",createdAt:1,lastActiveAt:1,preferredCats:[],featureRefs:[]})};
  const options={connector:f.connector,tasks,threads,assertCurrent:async()=>{},firstReceipts:{storage,messaging:{get:async(id:string)=>structuredClone(messages.get(id)??null)}}};
  if (!bootstrap) await createCaller(options).admit(firstSelection);
  const firstKey=manualWorkFirstReceiptKey("local-owner","first",f.agent.catId),first=structuredClone(records.get(firstKey));
  const current=await f.connector.readAssignedWork(f.connection.connectionId,work.workId);
  const continued=await f.connector.continueWork(f.source,f.agent,{workId:work.workId,expectedRevision:current.revision,
    kind:"resume",grantRef:f.input.grantRef,grantRevision:f.input.grantRevision,requestKind:f.input.requestKind});
  await f.connector.sync(f.connection.connectionId);const selection=await publish(continued.executionAuthority!.eventId,"second");
  return {...f,work,continued,selection,options,records,messages,firstKey,first,prepares,dispatches,
    task,make:()=>createCaller(options),evidence:()=>{aggregate++;}};
}
test("later registered execution stays on its first Task, has a separate receipt/ack and preserves first choice",async()=>{
  const f=await setup();try {f.evidence();const next=await f.make().admit(f.selection);
    expect(next).toMatchObject({taskRef:"task:work:task",taskRevision:2,admissionRef:"message:admission",executionRef:"message:second-execution"});
    expect(f.records.get(f.firstKey)).toEqual(f.first);expect(f.records.size).toBe(2);
    const second=[...f.records].find(([key])=>key!==f.firstKey)![1].value as {kind:string;firstSourceMessageId:string;work:{executionRevision:number};binding:{refScope:string}};
    expect(second.kind).toBe("continued_execution");expect(second.firstSourceMessageId).toBe("first");expect(second.work.executionRevision).toBe(2);
    expect(second.binding.refScope).toContain(":result:1:execution:2:");
    expect((await f.connector.readAssignedWork(f.connection.connectionId,f.work.workId)).executionAuthority?.hostAdmission?.state).toBe("admitted");
  }finally{await f.close();}
});
test("later execution replay after evidence reuses binding and never prepares or rewrites either receipt",async()=>{
  const f=await setup();try {const first=await f.make().admit(f.selection);if(first.result==="needs_clarification")throw Error("Expected fixture admission");const records=structuredClone([...f.records]);f.evidence();
    f.options.tasks.prepareEntrusted=async()=>{throw Error("Bound replay must dispatch the original execution");};
    const next=await f.make().admit(f.selection);expect(next).toMatchObject({executionRef:first.executionRef,taskRevision:first.taskRevision,queue:first.queue});
    expect([...f.records]).toEqual(records);
  }finally{await f.close();}
});
test("package owner branch cannot create a later receipt and only delegates bound dispatch to protected Host",async()=>{
  const f=await setup();try {await f.connector.withAssignedWorkAuthority(f.connection.connectionId,f.work.workId,scope=>
    expect(f.make().admitInScope(scope,f.selection,"owner_request")).rejects.toMatchObject({code:"OWNER_ADMISSION_UNAVAILABLE"}));
    expect(f.prepares).toHaveLength(1);await f.make().admit(f.selection);const before=structuredClone([...f.records]);
    await f.connector.withAssignedWorkAuthority(f.connection.connectionId,f.work.workId,scope=>f.make().admitInScope(scope,f.selection,"owner_request"));
    expect([...f.records]).toEqual(before);
  }finally{await f.close();}
});
test("missing first choice or recalled birth source cannot be recaptured as a later execution",async()=>{
  const f=await setup();try {f.records.delete(f.firstKey);await expect(f.make().admit(f.selection)).rejects.toMatchObject({code:"WORK_TASK_UNAVAILABLE"});
    expect(f.prepares).toHaveLength(1);expect(f.dispatches).toHaveLength(1);
    f.records.set(f.firstKey,f.first!);f.messages.delete("first");await expect(f.make().admit(f.selection)).rejects.toMatchObject({code:"WORK_TASK_UNAVAILABLE"});
    expect(f.records.size).toBe(1);
  }finally{await f.close();}
});
test("new execution never borrows its first Service ack and dispatch waits for fresh exact acknowledgement",async()=>{
  const f=await setup();try {expect(f.continued.executionAuthority?.hostAdmission).toBeUndefined();
    await f.connector.withAssignedWorkAuthority(f.connection.connectionId,f.work.workId,scope=>
      expect(f.make().admitInScope({...scope,recordHostAdmission:async()=>{}},f.selection)).rejects.toMatchObject({code:"OWNER_ADMISSION_UNAVAILABLE"}));
    expect(f.dispatches).toHaveLength(1);expect(f.records.get(f.firstKey)).toEqual(f.first);
    await f.make().admit(f.selection);expect(f.dispatches).toHaveLength(2);expect(f.prepares).toHaveLength(2);
  }finally{await f.close();}
});

test("current execution bootstraps a missing first Task with lineage and current grant as separate receipts",async()=>{
  const f=await setup(true);try {
    const next=await f.make().admit(f.selection);
    expect(next).toMatchObject({taskRef:"task:work:task",taskRevision:1,executionRef:"message:first-execution"});
    expect(f.prepares).toHaveLength(1);expect(f.prepares[0]).toMatchObject({sourceMessageId:"first",subject:{kind:"new"}});
    const root=f.records.get(f.firstKey)!.value as {kind:string;bootstrapSourceMessageId:string;basis?:unknown;binding:unknown};
    const second=f.records.get(manualWorkFirstReceiptKey("local-owner","second",f.agent.catId))!.value as {kind:string;basis:{grantRef:string};binding:unknown};
    expect(root.kind).toBe("bootstrap_lineage");expect(root.bootstrapSourceMessageId).toBe("second");expect(root.basis).toBeUndefined();
    expect(second.kind).toBe("continued_execution");expect(second.basis.grantRef).toBe(f.input.grantRef);expect(root.binding).toEqual(second.binding);
    expect((await f.connector.readAssignedWork(f.connection.connectionId,f.work.workId)).executionAuthority?.hostAdmission?.state).toBe("admitted");
  }finally{await f.close();}
});
test("bootstrap bound evidence replay uses captured execution and does not rewrite either relation",async()=>{
  const f=await setup(true);try {const first=await f.make().admit(f.selection);const records=structuredClone([...f.records]);f.evidence();
    f.options.tasks.prepareEntrusted=async()=>{throw Error("Bound bootstrap must not prepare twice");};
    const next=await f.make().admit(f.selection);if(first.result==="needs_clarification")throw Error("Expected bootstrap");
    expect(next).toMatchObject({taskRef:first.taskRef,taskRevision:first.taskRevision,executionRef:first.executionRef,queue:first.queue});expect([...f.records]).toEqual(records);
  }finally{await f.close();}
});
test("bootstrap cannot dispatch with a missing fresh current Service acknowledgement",async()=>{
  const f=await setup(true);try {
    await f.connector.withAssignedWorkAuthority(f.connection.connectionId,f.work.workId,scope=>
      expect(f.make().admitInScope({...scope,recordHostAdmission:async()=>{}},f.selection)).rejects.toMatchObject({code:"OWNER_ADMISSION_UNAVAILABLE"}));
    expect(f.prepares).toHaveLength(1);expect(f.dispatches).toHaveLength(0);
    await f.make().admit(f.selection);expect(f.prepares).toHaveLength(1);expect(f.dispatches).toHaveLength(1);
  }finally{await f.close();}
});

async function bootstrapNative(humanBirth = false) {
  const f=await setup(true,humanBirth);const admitted=await f.make().admit(f.selection);
  if(admitted.result==="needs_clarification")throw Error("Expected bootstrap binding");
  const message=f.messages.get("first")!;
  const native:PluginNativeTaskContext={userId:"local-owner",catId:f.agent.catId,threadId:"child",invocationId:"native",
    originTriggerMessageId:"trigger",source:{id:message.id,threadId:message.threadId,userId:message.userId,catId:null,
      content:message.content,source:{connector:message.source!.connector,meta:message.source!.meta},extra:{pluginMessage:{instanceId:"instance"}}},
    task:{taskRef:admitted.taskRef,taskRevision:admitted.taskRevision,admissionRef:admitted.admissionRef,executionRef:admitted.executionRef,sourceRevision:1}};
  const action:PluginActionContext={userId:native.userId,catId:native.catId,threadId:native.threadId,invocationId:native.invocationId,
    originTriggerMessageId:native.originTriggerMessageId,ownerAuthProvenance:"unknown",toolExecutionPolicy:{mode:"plugin_native",pluginInstanceId:"instance"},assertCurrent:async()=>{}};
  const contextCaller:typeof createCollectiveAgentWorkContextCaller=process.env.OWNER_WORK_CALLER_COMPILED === "1"
    ? (await import(new URL("../../../../dist/agent-work-context-caller.js",import.meta.url).href)).createCollectiveAgentWorkContextCaller
    : createCollectiveAgentWorkContextCaller;
  const caller=contextCaller({connector:f.connector,context:{nativeContext:{current:async()=>native},tasks:f.options.tasks},
    firstReceipts:f.options.firstReceipts});
  return {...f,caller,action,native};
}
test("bootstrap native relation preserves Host first source and reads only current Service execution",async()=>{
  const f=await bootstrapNative();try {
    const result=await f.caller.withCurrentTask(f.action,async binding=>{
      expect(binding.auth.source.id).toBe("first");expect(binding.source.eventId).toBe(f.selection.identity.eventId);
      expect(binding.sourceRef).toBe("message:second");expect(binding.work.executionRevision).toBe(2);await binding.revalidate();return binding.work;
    });expect(result.workId).toBe(f.work.workId);
  }finally{await f.close();}
});
test("bootstrap native refuses either missing relation and either recalled source while Service remains current",async()=>{
  const f=await bootstrapNative();try {
    const secondKey=manualWorkFirstReceiptKey("local-owner","second",f.agent.catId),saved=f.records.get(secondKey)!;
    f.records.delete(secondKey);await expect(f.caller.withCurrentTask(f.action,async()=>{})).rejects.toBeDefined();f.records.set(secondKey,saved);
    const first=f.messages.get("first")!;f.messages.delete("first");await expect(f.caller.withCurrentTask(f.action,async()=>{})).rejects.toBeDefined();f.messages.set("first",first);
    const second=f.messages.get("second")!;f.messages.delete("second");await expect(f.caller.withCurrentTask(f.action,async()=>{})).rejects.toBeDefined();f.messages.set("second",second);
    f.records.delete(f.firstKey);await expect(f.caller.withCurrentTask(f.action,async()=>{})).rejects.toBeDefined();
  }finally{await f.close();}
});
test("bootstrap native rechecks current message after awaited grant before entering consumer",async()=>{
  const f=await bootstrapNative();try {
    const resolve=f.connector.resolveAcceptedWorkGrant.bind(f.connector);let consumeCount=0;
    f.connector.resolveAcceptedWorkGrant=async(...args)=>{const grant=await resolve(...args);f.messages.delete("second");return grant;};
    await expect(f.caller.withCurrentTask(f.action,async()=>{consumeCount++;})).rejects.toBeDefined();expect(consumeCount).toBe(0);
  }finally{await f.close();}
});

test("bootstrap response loss on second binding recovers both exact receipts before ack and dispatch",async()=>{
  const f=await setup(true);try {
    const secondKey=manualWorkFirstReceiptKey("local-owner","second",f.agent.catId);
    const write=f.options.firstReceipts.storage.compareAndSet;let lost=false;
    f.options.firstReceipts.storage.compareAndSet=async(key,revision,value)=>{
      const result=await write(key,revision,value);
      if(key===secondKey && (value as {binding?:unknown}).binding && !lost){lost=true;throw Error("Lost binding response");}return result;
    };
    await expect(f.make().admit(f.selection)).rejects.toThrow("Lost binding response");
    expect(f.prepares).toHaveLength(1);expect(f.dispatches).toHaveLength(0);const before=structuredClone([...f.records]);
    await f.make().admit(f.selection);expect(f.prepares).toHaveLength(1);expect(f.dispatches).toHaveLength(1);expect([...f.records]).toEqual(before);
    await expect(readWorkFirstReceipt(f.options.firstReceipts.storage,"local-owner","first",f.agent.catId)).rejects.toBeDefined();
  }finally{await f.close();}
});

test("registered continuation may reuse a Human-committed first Task without treating its old route scope as permission",async()=>{
  const f=await setup(false,true);try {
    const next=await f.make().admit(f.selection);expect(next).toMatchObject({taskRef:"task:work:task",executionRef:"message:second-execution"});
    expect(f.records.get(f.firstKey)).toEqual(f.first);expect(f.prepares).toHaveLength(2);
    const route=(await f.connector.getHostRoute(f.connection.connectionId))!,key=`${f.connection.authorizedHumanId}:${f.agent.catId}`;
    const branch={...route.agentRoutes[key]!};delete branch.standingWork;
    await f.connector.setHostRoute(f.connection.connectionId,{localOwnerUserId:route.localOwnerUserId,defaultIngressThreadId:route.defaultIngressThreadId,
      humanNotificationThreadId:route.humanNotificationThreadId,agentRoutes:{...route.agentRoutes,[key]:branch}},route.revision);
    await f.make().admit(f.selection);expect(f.records.get(f.firstKey)).toEqual(f.first);
    const current=await f.connector.readAssignedWork(f.connection.connectionId,f.work.workId);expect(current.executionAuthority?.hostAdmission?.state).toBe("admitted");
  }finally{await f.close();}
});
test("current registered grant may bootstrap a Human assignment with no prior private Task",async()=>{
  const f=await setup(true,true);try {
    const next=await f.make().admit(f.selection);expect(next).toMatchObject({taskRef:"task:work:task",executionRef:"message:first-execution"});
    expect(f.prepares).toHaveLength(1);expect(f.prepares[0]).toMatchObject({sourceMessageId:"first",subject:{kind:"new"}});
    const root=f.records.get(f.firstKey)!.value as {source:{identity:{actor:{kind:string}}};basis?:unknown};
    expect(root.source.identity.actor.kind).toBe("human");expect(root.basis).toBeUndefined();
  }finally{await f.close();}
});

test("native bootstrap preserves Human Host lineage while current Agent permission remains independently revocable",async()=>{
  const f=await bootstrapNative(true);try {
    await f.caller.withCurrentTask(f.action,async binding=>{
      expect(binding.auth.source.id).toBe("first");expect(binding.auth.source.source.meta?.participation).toMatchObject({actor:{kind:"human"}});
      expect(binding.source.actor.kind).toBe("agent");expect(binding.sourceRef).toBe("message:second");expect(binding.work.executionRevision).toBe(2);
    });
    await f.store.revokeConnection({sessionToken:f.owner.sessionToken,collectiveId:f.connection.collectiveId,connectionId:f.connection.connectionId});
    await expect(f.caller.withCurrentTask(f.action,async()=>{})).rejects.toBeDefined();
  }finally{await f.close();}
});

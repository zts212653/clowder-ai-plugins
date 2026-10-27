import {expect, test, vi} from 'vitest';
import {setup} from './message-work-roundtrip.fixture.js';
import {createCollectiveMessageWorkCaller} from '../../../collective-message-work.js';
import {admitCollectiveMessageWork, reconcileCollectiveMessageWorkResult, resumeCollectiveMessageWork} from '../../../collective-owner-work-result.js';

test('Service comment wakes the one existing private Task and its actual native call keeps current source authority', async () => {
  const f = await setup();
  try {
    const originalGet = f.context.messaging.get.bind(f.context.messaging);
    const messages = new Map<string, Awaited<ReturnType<typeof originalGet>>>();
    const byKey = new Map<string, {messageId: string; threadId: string}>();
    const create = vi.spyOn(f.context.tasks, 'create');
    vi.spyOn(f.context.messaging, 'get').mockImplementation(async id => messages.get(id) ?? originalGet(id));
    vi.spyOn(f.context.messaging, 'send').mockImplementation(async (threadId, draft) => {
      const prior = byKey.get(draft.idempotencyKey!);if(prior) return prior;
      const messageId = 'wake-message-' + byKey.size;
      messages.set(messageId, {id: messageId, threadId, userId: f.auth.userId, catId: null,
        content: (draft.payload.elements[0]!.payload as {text: string}).text,
        source: {connector: 'collective', label:'Collective', icon:'collective', meta: draft.meta}, mentions: [], timestamp: 5, sourceRevision: 'wake-revision'});
      const receipt = {messageId, threadId};byKey.set(draft.idempotencyKey!, receipt);return receipt;
    });
    await f.store.postHumanMessage(f.owner.sessionToken, {serviceInstanceId: f.connection.serviceInstanceId,
      collectiveId: f.connection.collectiveId, clientEventId: 'ordinary-work-comment',
      location: {channelId:'general', rootEventId:f.work.sourceEventId}, recipient:{kind:'channel'},
      replyToEventId:f.work.assignmentEventId, body:'Keep the original material and continue.'});
    await f.connector.sync(f.connection.connectionId);
    const event = (await f.connector.listInbox(f.connection.connectionId)).find(row => row.event.workWakeNotice?.workId === f.work.workId)!.event;
    const sent = await f.caller.wake(f.connection.connectionId, event.eventId, f.auth.userId, async()=>{});
    expect(sent.threadId).toBe(f.task.threadId);
    expect(await f.caller.wake(f.connection.connectionId,event.eventId,f.auth.userId,async()=>{})).toEqual(sent);
    expect(byKey.size).toBe(1);expect(create).not.toHaveBeenCalled();
    const binding = await f.caller.withCurrentMessage({...f.action,originTriggerMessageId:sent.messageId}, async binding=>({
      sourceEventId:binding.source.eventId, workId:binding.work.workId, resultRevision:binding.work.resultRevision}));
    expect(binding).toEqual({sourceEventId:f.work.assignmentEventId, workId:f.work.workId, resultRevision:1});
    await expect(f.caller.wake(f.connection.connectionId,event.eventId,'foreign-owner',async()=>{})).rejects.toThrow();
    Object.assign(f.task,{status:'done'});
    await expect(f.caller.wake(f.connection.connectionId,event.eventId,f.auth.userId,async()=>{})).rejects.toThrow();
    expect(byKey.size).toBe(1);
  } finally {vi.restoreAllMocks();await f.close();}
});

test('browser acceptance repeats read-only after the same installation lifecycle makes its satisfied Task controller stale', async () => {
  const f = await setup();
  try {
    const operation = await f.caller.withCurrentMessage(f.action, async binding => {
      const prepared = await f.connector.prepareReply(binding.source, binding.sourceRef, binding.resultKey,
        binding.work.revision, binding.work.resultRevision,
        {revision: binding.work.executionRevision, assignmentEventId: binding.work.assignmentEventId});
      await f.connector.submitReply(binding.source, binding.sourceRef, binding.resultKey, prepared.outboxId, 'Ready for owner acceptance.',
        f.agent, undefined, binding.work.resultRevision,
        {revision: binding.work.executionRevision, assignmentEventId: binding.work.assignmentEventId});
      await f.connector.sync(f.connection.connectionId);
      return f.connector.prepareReply(binding.source, binding.sourceRef, binding.resultKey,
        binding.work.revision, binding.work.resultRevision,
        {revision: binding.work.executionRevision, assignmentEventId: binding.work.assignmentEventId});
    });
    const ready = await f.connector.readAssignedWork(f.connection.connectionId, f.work.workId);
    const coords = {serviceInstanceId: f.connection.serviceInstanceId, collectiveId: f.connection.collectiveId,
      connectionId: f.connection.connectionId, workId: f.work.workId};
    const input = {...coords, workRevision: ready.revision, assignmentEventId: ready.assignmentEventId!,
      resultEventId: operation.acceptedEventId!, resultRevision: ready.resultRevision!};
    const reconcile = (unsafe = input, owner = f.auth.userId) => reconcileCollectiveMessageWorkResult(f.connector,
      f.context, owner, f.connection.connectionId, unsafe, async () => {});
    await expect(reconcile()).rejects.toMatchObject({code: 'COLLECTIVE_RESULT_NOT_CURRENT'});
    expect(f.updates()).toBe(0);
    const accepted = await f.store.acceptCollectiveWorkResult(f.owner.sessionToken, {
      serviceInstanceId: coords.serviceInstanceId, collectiveId: coords.collectiveId, workId: coords.workId,
      expectedRevision: ready.revision, resultEventId: input.resultEventId, resultRevision: input.resultRevision,
      requestId: 'accept-ordinary-result'});
    input.workRevision = accepted.revision;
    await expect(reconcile({...input, workRevision: input.workRevision - 1})).rejects.toMatchObject({code: 'COLLECTIVE_RESULT_NOT_CURRENT'});
    await expect(reconcile(input, 'foreign-owner')).rejects.toMatchObject({code: 'CONNECTOR_OWNER_MISMATCH'});
    expect(f.updates()).toBe(0);
    const controller = (currentForCaller: boolean) => ({
      bindingRevision: 1, state: 'active' as const, currentForCaller,
      binding: {userId: f.auth.userId, catId: f.auth.catId, threadId: f.task.threadId,
        subjectKey: f.task.subjectKey!, firstSourceRef: 'message:canonical-source',
        admissionAuthorityRef: f.task.entrustedWork!.admission.authorityRef!,
        pluginId: 'official.collective-connector', pluginInstanceId: 'installed-collective',
        moduleRef: 'plugin:official.collective-connector', lifecycleRevision: 1,
        ownerOperationReceiptRef: `task-data-controller:${'a'.repeat(64)}`},
    });
    Object.assign(f.task, {entrustedWork: {...f.task.entrustedWork!, dataController: controller(false)}});
    await expect(reconcile()).rejects.toMatchObject({code: 'OWNER_ADOPTION_REQUIRED'});
    expect(f.updates()).toBe(0);
    Object.assign(f.task, {entrustedWork: {...f.task.entrustedWork!, dataController: controller(true)}});
    expect(await reconcile()).toEqual({result: 'closed', taskId: f.task.id, revision: 2});
    expect(f.task.status).toBe('done');
    Object.assign(f.task, {entrustedWork: {...f.task.entrustedWork!, dataController: controller(false)}});
    expect(await reconcile()).toEqual({result: 'already_closed', taskId: f.task.id, revision: 2});
    expect(f.updates()).toBe(1);
    Object.assign(f.task, {entrustedWork: {...f.task.entrustedWork!, dataController: {
      ...controller(false), state: 'revoked' as const,
      revocationReceiptRef: `task-data-controller:${'b'.repeat(64)}`,
    }}});
    await expect(reconcile()).rejects.toMatchObject({code: 'OWNER_ADOPTION_REQUIRED'});
    Object.assign(f.task, {entrustedWork: {...f.task.entrustedWork!, dataController: controller(false)}});
    await expect(reconcileCollectiveMessageWorkResult(f.connector,
      {...f.context, pluginInstanceId: 'replacement-collective'}, f.auth.userId, f.connection.connectionId,
      input, async () => {})).rejects.toMatchObject({code: 'OWNER_ADOPTION_REQUIRED'});
    expect(f.updates()).toBe(1);
  } finally {await f.close();}
});

test('the original Continue button refuses a stale Task observation or revoked Service grant', async () => {
  const f = await setup();
  try {
    const input = {taskId: f.task.id, observedRevision: f.task.updatedAt, requestId: 'c06803ce-c8de-4864-8cbf-6cf16c15e723'};
    const resume = (unsafe: unknown) => resumeCollectiveMessageWork(f.connector, f.context, f.caller,
      f.auth.userId, f.connection.connectionId, unsafe, async () => {});
    await expect(resume({...input, observedRevision: 2})).rejects.toMatchObject({code: 'OWNER_ADMISSION_UNAVAILABLE'});
    await f.connector.revokeWorkGrants(f.connection.connectionId, f.auth.userId, [f.input.grantRef]);
    await expect(resume(input)).rejects.toThrow();
    expect(f.wakes()).toBe(1);
  } finally {await f.close();}
});

test('ordinary no-policy/no-Task-binding invocation returns Work to the real Service once', async () => {
  const f = await setup();
  try {
    const returned = await f.consume(f.action, async binding => {
      expect('task' in binding.auth).toBe(false);
      const operation = await f.connector.prepareReply(binding.source, binding.sourceRef, binding.resultKey,
        binding.work.revision, binding.work.resultRevision,
        {revision: binding.work.executionRevision, assignmentEventId: binding.work.assignmentEventId});
      await f.connector.submitReply(binding.source, binding.sourceRef, binding.resultKey, operation.outboxId, 'Implemented A.', f.agent,
        undefined, binding.work.resultRevision, {revision: binding.work.executionRevision, assignmentEventId: binding.work.assignmentEventId});
      await f.connector.sync(binding.source.connectionId);
      return f.connector.prepareReply(binding.source, binding.sourceRef, binding.resultKey, binding.work.revision,
        binding.work.resultRevision, {revision: binding.work.executionRevision, assignmentEventId: binding.work.assignmentEventId});
    });
    expect(returned.status).toBe('accepted');
    const work = await f.connector.readAssignedWork(f.connection.connectionId, f.work.workId);
    expect(work.lifecycle).toBe('result_ready');
    expect(work.resultEventId).toBe(returned.acceptedEventId);
    await f.caller.send(f.source.connectionId, f.source.eventId, f.auth.userId, async () => {});
    expect(f.wakes()).toBe(1);
  } finally {await f.close();}
});

test('a matching legacy Task without an active controller stops before Task create or Cat wake',async()=>{
  const f=await setup();
  try{
    Object.assign(f.task,{subjectKey:'entrusted:legacy',entrustedWork:{...f.task.entrustedWork!,revision:3,
      admission:{sourceRefs:['message:canonical-source'],authorityRef:'message:original-admission'}}});
    const before=structuredClone(f.task),create=vi.spyOn(f.context.tasks,'create'),send=vi.spyOn(f.context.messaging,'send');
    await expect(f.caller.send(f.source.connectionId,f.source.eventId,f.auth.userId,async()=>{}))
      .rejects.toMatchObject({code:'OWNER_ADOPTION_REQUIRED'});
    expect(create).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();expect(f.task).toEqual(before);
  }finally{vi.restoreAllMocks();await f.close();}
});

test('Task controller authority is rechecked after the last pre-wake yield',async()=>{
  const f=await setup();
  try{
    const send=vi.spyOn(f.context.messaging,'send');
    const caller=createCollectiveMessageWorkCaller(f.connector,f.context,{beforeWake:async()=>{
      Object.assign(f.task,{entrustedWork:{...f.task.entrustedWork!,admission:{...f.task.entrustedWork!.admission,
        authorityRef:'message:retired-installation'}}});
    }});
    await expect(caller.send(f.source.connectionId,f.source.eventId,f.auth.userId,async()=>{}))
      .rejects.toMatchObject({code:'OWNER_ADOPTION_REQUIRED'});
    expect(send).not.toHaveBeenCalled();
  }finally{vi.restoreAllMocks();await f.close();}
});

test.each([
  ['revoked controller','OWNER_ADOPTION_REQUIRED'],
  ['terminal Task','OWNER_TASK_UNAVAILABLE'],
  ['locator drift','WORK_EXECUTION_NOT_CURRENT'],
] as const)('wake revalidates %s before sending',async(drift,code)=>{
  const f=await setup();
  try{
    const work=f.task.entrustedWork!;
    Object.assign(f.task,{entrustedWork:{...work,dataController:{
      bindingRevision:1,state:'active',currentForCaller:true,
      binding:{userId:f.auth.userId,catId:f.auth.catId,threadId:f.task.threadId,
        subjectKey:f.task.subjectKey!,firstSourceRef:'message:canonical-source',
        admissionAuthorityRef:work.admission.authorityRef!,pluginId:'official.collective-connector',
        pluginInstanceId:'installed-collective',moduleRef:'plugin:official.collective-connector',
        lifecycleRevision:1,ownerOperationReceiptRef:`task-data-controller:${'a'.repeat(64)}`},
    }}});
    await f.store.postHumanMessage(f.owner.sessionToken,{serviceInstanceId:f.connection.serviceInstanceId,
      collectiveId:f.connection.collectiveId,clientEventId:`wake-${drift}`,
      location:{channelId:'general',rootEventId:f.work.sourceEventId},recipient:{kind:'channel'},
      replyToEventId:f.work.assignmentEventId,body:'Continue original Work.'});
    await f.connector.sync(f.connection.connectionId);
    const event=(await f.connector.listInbox(f.connection.connectionId))
      .find(row=>row.event.workWakeNotice?.workId===f.work.workId)!.event;
    const send=vi.spyOn(f.context.messaging,'send');
    const caller=createCollectiveMessageWorkCaller(f.connector,f.context,{beforeWake:async()=>{
      if(drift==='revoked controller')Object.assign(f.task,{entrustedWork:{...f.task.entrustedWork!,
        revision:f.task.entrustedWork!.revision+1,dataController:{...f.task.entrustedWork!.dataController!,
          bindingRevision:2,state:'revoked',currentForCaller:false,
          revocationReceiptRef:`task-data-controller:${'b'.repeat(64)}`}}});
      else if(drift==='terminal Task')Object.assign(f.task,{status:'done',entrustedWork:{...f.task.entrustedWork!,
        revision:f.task.entrustedWork!.revision+1,closure:{...f.task.entrustedWork!.closure,state:'satisfied'}}});
      else{
        const drifted=structuredClone({...f.task,id:'other-task'});
        const originalGet=f.context.tasks.get.bind(f.context.tasks);
        vi.spyOn(f.context.tasks,'list').mockResolvedValue([drifted]);
        vi.spyOn(f.context.tasks,'get').mockImplementation(async selector=>
          selector.id===drifted.id?drifted:originalGet(selector));
      }
    }});
    await expect(caller.wake(f.connection.connectionId,event.eventId,f.auth.userId,async()=>{}))
      .rejects.toMatchObject({code});
    expect(send).not.toHaveBeenCalled();
  }finally{vi.restoreAllMocks();await f.close();}
});

test('ordinary Work uses the injected Cat and current installation as separate authorization coordinates', async () => {
  const f = await setup();
  try {
    await expect(f.caller.withCurrentMessage({...f.action, catId: 'other-cat'}, async () => true)).rejects.toThrow();
    await expect(createCollectiveMessageWorkCaller(f.connector, {...f.context, pluginInstanceId: 'other-instance'})
      .withCurrentMessage(f.action, async binding => binding.auth.pluginInstanceId)).rejects.toMatchObject({code:'OWNER_ADOPTION_REQUIRED'});
  } finally {await f.close();}
});

test('ordinary Work still refuses current Service revoke and expired consumer use', async () => {
  const f = await setup();
  try {
    let retained: (() => Promise<void>) | undefined;
    await f.caller.withCurrentMessage(f.action, async binding => {retained = binding.revalidate;});
    await expect(retained!()).rejects.toThrow();
    await f.connector.revokeWorkGrants(f.connection.connectionId, f.auth.userId, [f.input.grantRef]);
    await expect(f.caller.withCurrentMessage(f.action, async () => true)).rejects.toThrow();
    f.expire();
    await expect(f.caller.withCurrentMessage(f.action, async () => true)).rejects.toThrow();
  } finally {await f.close();}
});


test('original Human standing Work uses ordinary invocation and its current route scope', async () => {
  const f = await setup('human-standing');
  try {
    expect(f.source.actor.kind).toBe('human');expect(f.work.acceptance).toBeUndefined();
    await f.caller.withCurrentMessage(f.action, async binding => {
      expect(binding.work.workId).toBe(f.work.workId);expect('task' in binding.auth).toBe(false);
      const prepared = await f.connector.prepareReply(binding.source, binding.sourceRef, binding.resultKey,
        binding.work.revision, binding.work.resultRevision);
      await f.connector.submitReply(binding.source, binding.sourceRef, binding.resultKey, prepared.outboxId,
        'Original Human Work completed.', f.agent, undefined, binding.work.resultRevision);
      await f.connector.sync(f.connection.connectionId);
    });
    expect((await f.connector.readAssignedWork(f.connection.connectionId, f.work.workId)).lifecycle).toBe('result_ready');
    const route = (await f.connector.getHostRoute(f.connection.connectionId))!;
    const key = `${f.owner.human.humanId}:${f.agent.catId}`;
    const branch = {...route.agentRoutes[key]!};delete branch.standingWork;
    await f.connector.setHostRoute(f.connection.connectionId, {localOwnerUserId: route.localOwnerUserId,
      defaultIngressThreadId: route.defaultIngressThreadId, humanNotificationThreadId: route.humanNotificationThreadId,
      agentRoutes: {...route.agentRoutes, [key]: branch}}, route.revision);
    await expect(f.caller.withCurrentMessage(f.action, async () => true)).rejects.toThrow();
    expect(f.wakes()).toBe(1);
  } finally {await f.close();}
});


test('original manual Human click retains one exact Task locator across HTTP retry without inventing execution authority', async () => {
  const f = await setup('human-manual');
  try {
    const first = structuredClone([...f.records]);
    const choice = first.find(([,entry]) => (entry.value as {basis?:{kind?:string}}).basis?.kind === 'manual_owner_write')!;
    expect((choice[1].value as {basis: {kind: string};binding?:{taskRef:string;dataControllerReceiptRef?:string}}).basis.kind).toBe('manual_owner_write');
    expect((choice[1].value as {binding:{taskRef:string}}).binding.taskRef).toBe(`task:work:${f.task.id}`);
    expect((choice[1].value as {binding:{dataControllerReceiptRef?:string}}).binding.dataControllerReceiptRef).toBeUndefined();
    const replay = await admitCollectiveMessageWork(f.connector, f.context, f.caller,
      {...f.ownerHttp, requestIdentity: {...f.ownerHttp.requestIdentity!, requestId: 'another-authenticated-http'}},
      f.source.connectionId, f.ownerInput, async () => {});
    expect(replay).toMatchObject({taskRef: `task:work:${f.task.id}`, messageId: f.auth.source.id});
    expect([...f.records]).toEqual(first);expect(f.wakes()).toBe(1);
    await f.caller.withCurrentMessage(f.action, async binding => {
      expect(binding.work.workId).toBe(f.work.workId);expect(binding.auth).not.toHaveProperty('task');
    });
    // A UI Task is a relationship, never a substitute for the owner click.
    f.records.clear();
    await expect(f.caller.withCurrentMessage(f.action, async () => true)).rejects.toThrow();
  } finally {await f.close();}
});

test('ordinary send keeps the original Schedule contract and uses its data revision without an execution binding', async () => {
  const f = await setup();
  try {
    expect(f.task.entrustedWork).toMatchObject({revision: 1, closure: {state: 'open'}, admission: {sourceRefs: ['message:canonical-source']}});
    Object.assign(f.task, {updatedAt: 9000});
    await f.caller.withCurrentMessage(f.action, async binding => {
      expect(binding.work.revision).toBe(1);expect(binding.auth).not.toHaveProperty('task');
    });
    const resumed = await resumeCollectiveMessageWork(f.connector, f.context, f.caller, f.auth.userId, f.connection.connectionId,
      {taskId: f.task.id, observedRevision: 1, requestId: '5729235d-c14a-4cdf-a36f-f31edc0665a5'}, async () => {});
    expect(resumed.revision).toBe(1);expect(f.wakes()).toBe(1);
  } finally {await f.close();}
});

test('explicit artifact registration advances only the same Task snapshot while keeping the ordinary invocation current', async () => {
  const f = await setup();
  try {
    await f.caller.withCurrentMessage(f.action, async binding => {
      await binding.registerArtifactRefs(1, ['/uploads/report.md']);
      expect(binding.work.revision).toBe(2);expect(binding.artifactRefs).toEqual(['/uploads/report.md']);
      expect(binding.work.executionRevision).toBe(1);await binding.revalidate();
      await expect(binding.registerArtifactRefs(1, ['/uploads/other.md'])).rejects.toMatchObject({code: 'WORK_ARTIFACT_REVISION_CONFLICT'});
    });
    expect(f.task.entrustedWork!.revision).toBe(2);expect(f.updates()).toBe(1);expect(f.wakes()).toBe(1);
  } finally {await f.close();}
});

test('the actual Task writing boundary refuses invalid selections before CAS and compares the canonical single ref', async () => {
  const f = await setup();
  try {
    await f.caller.withCurrentMessage(f.action, async binding => {
      for (const refs of [[], ['/uploads/z.md', '/uploads/a.md'], ['/uploads/a.md', '/uploads/a.md']]) {
        await expect(binding.registerArtifactRefs(1, refs)).rejects.toThrow();
        expect(f.updates()).toBe(0);expect(f.task.entrustedWork!.revision).toBe(1);
      }
      await binding.registerArtifactRefs(1, [' /uploads/report.md ']);
      expect(binding.artifactRefs).toEqual(['/uploads/report.md']);expect(f.updates()).toBe(1);
    });
  } finally {await f.close();}
});

import {expect, test} from 'vitest';
import type {FeatureContext, PluginActionContext, PluginNativeContext, PluginTaskReadItem, PluginOwnerHttpContext} from '@clowder-ai/plugin-sdk';
import {fixture} from './communication-work-custody.fixture.js';
import {collectiveEventSourceIdentity} from '../../contracts/index.js';
import {collectiveSource} from '../../../collective-ingress-routing.js';
import {createCollectiveMessageWorkCaller} from '../../../collective-message-work.js';
import {createCollectiveAgentWorkContextCaller} from '../../../agent-work-context-caller.js';
import {reconcileCollectiveMessageWorkResult, resumeCollectiveMessageWork, admitCollectiveMessageWork} from '../../../collective-owner-work-result.js';

// Service/Connector are production implementations; Host invocation and Task UI
// records here are fixtures. The actual Host HTTP probe is separate evidence.
async function setup(mode: 'agent' | 'human-standing' | 'human-manual' = 'agent') {
  const f = await fixture();
  await f.connector.adoptWorkPolicy(f.connection.connectionId, 'local-owner', f.policy.revision);
  const work = mode === 'agent' ? await f.connector.acceptWork(f.source, f.agent, f.input) : await (async () => {
    const coordinates = {serviceInstanceId: f.connection.serviceInstanceId, collectiveId: f.connection.collectiveId};
    const proposed = await f.store.proposeCollectiveWork(f.owner.sessionToken, {...coordinates,
      sourceEventId: f.source.eventId, requestId: 'ordinary-human-propose'});
    const committed = await f.store.commitCollectiveWork(f.owner.sessionToken, {...coordinates,
      workId: proposed.workId, expectedRevision: proposed.revision, requestId: 'ordinary-human-commit',
      assignment: {connectionId: f.connection.connectionId, catId: f.agent.catId, participationRevision: 1}});
    const route = (await f.connector.getHostRoute(f.connection.connectionId))!;
    const key = `${f.owner.human.humanId}:${f.agent.catId}`;
    if (mode === 'human-standing') await f.connector.setHostRoute(f.connection.connectionId, {localOwnerUserId: route.localOwnerUserId,
      defaultIngressThreadId: route.defaultIngressThreadId, humanNotificationThreadId: route.humanNotificationThreadId,
      agentRoutes: {...route.agentRoutes, [key]: {...route.agentRoutes[key]!, standingWork: {
        requestingHumanIds: [f.owner.human.humanId], channelIds: ['general'], expiresAt: null}}}}, route.revision);
    return committed;
  })();
  await f.connector.sync(f.connection.connectionId);
  const item = (await f.connector.listInbox(f.connection.connectionId)).find(row => row.event.eventId === work.assignmentEventId)!;
  const source = collectiveEventSourceIdentity(item.event)!;
  const projected = collectiveSource(item.event, source);
  let active = true;
  const auth: PluginNativeContext = {userId: 'local-owner', catId: f.agent.catId, threadId: 'private',
    invocationId: f.agent.sessionRef, originTriggerMessageId: 'message-source',
    source: {id: 'message-source', threadId: 'private', userId: 'local-owner', catId: null, content: item.event.body,
      source: {connector: 'collective', meta: projected.meta}, extra: {pluginMessage: {instanceId: 'installed-collective'}}}};
  const task: PluginTaskReadItem = {id: 'ordinary-ui-task', kind: 'work', userId: auth.userId, threadId: auth.threadId,
    ownerCatId: auth.catId, subjectKey: `collective-work:${source.connectionId}:${work.workId}`, title: work.title,
    why: work.intendedOutcome, status: 'todo', createdBy: auth.userId, createdAt: 1, updatedAt: 1};
  let wakes = 0;
  let updates = 0;
  let created = false;
  const original = {id: 'canonical-source', threadId: 'channel', userId: auth.userId, catId: null,
    content: item.event.body, source: projected, timestamp: 1, sourceRevision: 'canonical-revision', mentions: []};
  const records = new Map<string, {revision: number; value: unknown}>();let storageRevision = 0;
  const context = {storage: {get: async (key: string) => structuredClone(records.get(key)),
    compareAndSet: async (key: string, expected: number | null, value: unknown) => {
      if ((records.get(key)?.revision ?? null) !== expected) return {applied: false};
      records.set(key, {revision: ++storageRevision, value: structuredClone(value)});return {applied: true, revision: storageRevision};
    }}, pluginInstanceId: 'installed-collective',
    nativeContext: {current: async (input?: unknown) => {expect(input).toBeUndefined();if (!active) throw Error('expired');return structuredClone(auth);}},
    tasks: {get: async () => task, getBySubject: async (key: string) => created && key === task.subjectKey ? task : null,
      listByKind: async () => [], upsertBySubject: async (input: {entrustedWork?: {sourceMessageId: string; time?: unknown}}) => {
        created = true;
        if (input.entrustedWork) Object.assign(task, {entrustedWork: {revision: 1, closure: {state: 'open'},
          time: input.entrustedWork.time ?? {}, artifactRefs: [], admission: {sourceRefs: [`message:${input.entrustedWork.sourceMessageId}`]}}});
        return task;},
      updateIfThreadId: async (id: string, threadId: string, patch: object) => {
        if (task.id !== id || task.threadId !== threadId) return null;
        updates++;
        const change = patch as {entrustedWork?: {expectedRevision: number; closure?: {state: string}; artifactRefs?: readonly string[]}};
        if (change.entrustedWork) {
          expect(change.entrustedWork.expectedRevision).toBe(task.entrustedWork!.revision);
          Object.assign(task, {...(change.entrustedWork.closure ? {status: 'done'} : {}), entrustedWork: {...task.entrustedWork,
            revision: task.entrustedWork!.revision + 1, ...(change.entrustedWork.closure ? {closure: change.entrustedWork.closure} : {}),
            ...(change.entrustedWork.artifactRefs ? {artifactRefs: [...change.entrustedWork.artifactRefs]} : {})}, updatedAt: task.updatedAt + 1});
        } else Object.assign(task, patch, {updatedAt: task.updatedAt + 1});
        return task;
      }},
    threads: {ensureByKey: async () => ({id: 'private'})},
    messaging: {get: async (id: string) => id === auth.source.id ? {...original, id, threadId: auth.threadId} : original, send: async (thread: string, draft: {wake?: unknown}) => {
      if (!draft.wake) {expect(thread).toBe('channel');return {messageId: original.id, threadId: original.threadId};}
      expect(thread).toBe('private');
      if (!wakes) {expect(draft.wake).toEqual({catId: auth.catId});wakes++;}
      return {messageId: auth.source.id, threadId: auth.threadId};}},
  } as unknown as FeatureContext;
  const caller = createCollectiveMessageWorkCaller(f.connector, context);
  const ownerHttp: PluginOwnerHttpContext = {kind: 'owner-http-request', pluginInstanceId: context.pluginInstanceId,
    userId: auth.userId, operation: 'write', signal: new AbortController().signal, assertCurrent: async () => {},
    requestIdentity: {kind: 'owner_http', requestId: 'actual-http-request', transportRequestId: 'fixture',
      pluginId: 'official.collective-connector', pluginInstanceId: context.pluginInstanceId, userId: auth.userId,
      contributionId: 'collective-work-admit', method: 'POST', declaredPath: 'connections/:connectionId/work/admit',
      path: `connections/${source.connectionId}/work/admit`, bodyDigest: 'a'.repeat(64), queryDigest: 'b'.repeat(64)}};
  const ownerInput = {sourceMessageId: original.id, requestId: 'b24b2f38-38e7-47fe-a180-bf72a48db371'};
  if (mode === 'human-manual') {
    await expect(caller.send(source.connectionId, source.eventId, auth.userId, async () => {})).rejects.toThrow();
    expect(created).toBe(false);expect(wakes).toBe(0);
    await admitCollectiveMessageWork(f.connector, context, caller, ownerHttp, source.connectionId, ownerInput, async () => {});
  } else await caller.send(source.connectionId, source.eventId, auth.userId, async () => {});
  const action: PluginActionContext = {userId: auth.userId, catId: auth.catId, threadId: auth.threadId,
    invocationId: auth.invocationId, originTriggerMessageId: auth.originTriggerMessageId,
    ownerAuthProvenance: 'unknown', assertCurrent: async () => {if (!active) throw Error('expired');}};
  const consume = process.env.MESSAGE_WORK_LEGACY === '1'
    ? createCollectiveAgentWorkContextCaller({connector: f.connector, context}).withCurrentTask
    : caller.withCurrentMessage;
  return {...f, work, source, auth, action, context, caller, consume,
    task, records, ownerHttp, ownerInput, expire: () => {active = false;}, wakes: () => wakes, updates: () => updates};
}

test('browser acceptance closes only the same current Service result and repeats without another Task mutation', async () => {
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
    expect(await reconcile()).toEqual({result: 'closed', taskId: f.task.id, revision: 2});
    expect(f.task.status).toBe('done');
    expect(await reconcile()).toEqual({result: 'already_closed', taskId: f.task.id, revision: 2});
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

test('ordinary Work source cannot replace its authenticated Cat or installed instance', async () => {
  const f = await setup();
  try {
    await expect(f.caller.withCurrentMessage({...f.action, catId: 'other-cat'}, async () => true)).rejects.toThrow();
    await expect(createCollectiveMessageWorkCaller(f.connector, {...f.context, pluginInstanceId: 'other-instance'})
      .withCurrentMessage(f.action, async () => true)).rejects.toThrow();
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


test('original manual Human click retains its choice across HTTP retry without a Task execution identity', async () => {
  const f = await setup('human-manual');
  try {
    const first = structuredClone([...f.records]);
    expect((first[0]![1].value as {basis: {kind: string}; binding?: unknown}).basis.kind).toBe('manual_owner_write');
    expect(first[0]![1].value).not.toHaveProperty('binding');
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

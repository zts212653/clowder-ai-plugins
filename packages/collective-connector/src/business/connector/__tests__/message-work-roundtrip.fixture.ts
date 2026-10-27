import {expect, vi} from 'vitest';
import {createHash} from 'node:crypto';
import type {FeatureContext, PluginActionContext, PluginTaskReadItem, PluginOwnerHttpContext} from '@clowder-ai/plugin-sdk';
import {fixture} from './communication-work-custody.fixture.js';
import {collectiveEventSourceIdentity} from '../../contracts/index.js';
import {collectiveSource} from '../../../collective-ingress-routing.js';
import {createCollectiveMessageWorkCaller} from '../../../collective-message-work.js';
import {admitCollectiveMessageWork} from '../../../collective-owner-work-result.js';

// Production Service/Connector; explicit in-memory Host ports only.
export async function setup(mode: 'agent' | 'human-standing' | 'human-manual' = 'agent') {
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
  const auth = {userId: 'local-owner', catId: f.agent.catId, threadId: 'private',
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

    tasks: {get: async (selector: {id?: string; subjectKey?: string}) => selector.id===task.id || created && selector.subjectKey===task.subjectKey ? task : null,
      list: async () => created ? [task] : [], create: async (input: {entrustedWork?: {sourceMessageId: string; time?: unknown}}, options?: {onConflict?: string}) => {
        expect(options).toEqual({onConflict:'update'});created = true;
        if (input.entrustedWork) Object.assign(task, {entrustedWork: {revision: 1, closure: {state: 'open'},
          time: input.entrustedWork.time ?? {}, artifactRefs: [], admission: {sourceRefs: [`message:${input.entrustedWork.sourceMessageId}`],
            authorityRef:`plugin-task-data:${createHash('sha256').update(JSON.stringify(['installed-collective',task.subjectKey])).digest('hex')}`}}});
        return task;},
      update: async (id: string, patch: object, conditions?: {expectedThreadId?: string}) => {
        if (task.id !== id || task.threadId !== conditions?.expectedThreadId) return null;
        updates++;
        const change = patch as {entrustedWork?: {expectedRevision: number; closure?: {state: string}; artifactRefs?: readonly string[]}};
        if (change.entrustedWork) {
          expect(change.entrustedWork.expectedRevision).toBe(task.entrustedWork!.revision);
          Object.assign(task, {...(change.entrustedWork.closure ? {status: 'done'} : {}), entrustedWork: {...task.entrustedWork,
            revision: task.entrustedWork!.revision + 1, ...(change.entrustedWork.closure ? {closure: change.entrustedWork.closure} : {}),
            ...(change.entrustedWork.artifactRefs ? {artifactRefs: [...change.entrustedWork.artifactRefs]} : {})}, updatedAt: task.updatedAt + 1});
        } else Object.assign(task, patch, {updatedAt: task.updatedAt + 1});
        return task;
      },bindDataController:async()=>{throw new Error('new Tasks do not need controller adoption');},
      revokeDataController:async()=>{throw new Error('new Tasks have no controller adoption');}},
    threads: {get:async(id:string)=>({id,title:'Work',deepLinkUrl:'https://fixture/'+id,createdAt:1,lastActiveAt:1,preferredCats:[],featureRefs:[]}),create:async()=>({id:'private',title:'Work',deepLinkUrl:'https://fixture/private',createdAt:1,lastActiveAt:1,preferredCats:[],featureRefs:[]})},
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
  const consume=caller.withCurrentMessage;
  return {...f, work, source, auth, action, context, caller, consume,
    task, records, ownerHttp, ownerInput, expire: () => {active = false;}, wakes: () => wakes, updates: () => updates};
}

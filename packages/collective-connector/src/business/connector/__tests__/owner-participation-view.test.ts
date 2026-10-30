import {memoryStorage, serviceHostConfig, ownerAction, ownerCaller} from '../../../../test/runtime-fixture.js';
import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { type PluginTaskReadItem, type ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import entrypoint from '../../../plugin-entrypoint.js';
import { fixture } from './communication-work-custody.fixture.js';
import { ownerRequestExecution } from '../../../collective-owner-request-progress.js';
import { readCollectiveOwnerThreadCandidates } from '../../../owner-participation-caller.js';

const manifest = parse(await readFile(new URL('../../../../plugin.yaml', import.meta.url), 'utf8'));

test('original owner page shows ordinary Work in its private thread and accepted closure', async () => {
  const f = await setup();
  try {
    await f.connector.adoptWorkPolicy(f.connection.connectionId, 'local-owner', f.policy.revision);
    const work = await f.connector.acceptWork(f.source, f.agent, f.input);
    await f.connector.sync(f.connection.connectionId);
    const route = (await f.connector.getHostRoute(f.connection.connectionId))!;
    await f.connector.beginInboxRouting(f.connection.connectionId, work.assignmentEventId!, route.revision);
    await f.connector.completeInboxRouting(f.connection.connectionId, work.assignmentEventId!, route.revision,
      {kind: 'thread_message', messageId: 'ordinary-assignment', threadId: 'channel', catId: 'codex-sol'});
    f.rows.push({id: 'private-work', title: 'Original private Work', createdBy: 'local-owner', participants: ['codex-sol']});
    const task: PluginTaskReadItem = {id: 'ordinary-task', kind: 'work', title: work.title, why: work.intendedOutcome,
      subjectKey: `collective-work:${f.connection.connectionId}:${work.workId}`, threadId: 'private-work',
      ownerCatId: 'codex-sol', userId: null, createdBy: 'system', status: 'doing', createdAt: 1, updatedAt: 7};
    f.tasks.push(task, {...task, id: 'wrong-cat', ownerCatId: 'other-cat'});
    // A second Connector instance seeded the event; reopen the module to load
    // its persisted inbox, just as the existing restart fixtures do.
    await f.restart();
    expect(f.subscriptions.has('private-work')).toBe(true);
    const result = await f.invoke() as {status: number; body: {tasks: unknown[]}};
    expect(result.status).toBe(200);
    expect(result.body.tasks).toContainEqual({id: task.id, title: task.title, threadId: 'private-work', status: 'doing',
      revision: 7, closure: 'open', sourceRefs: ['message:ordinary-assignment']});
    expect(result.body.tasks).not.toContainEqual(expect.objectContaining({id: 'wrong-cat'}));
    f.tasks[f.tasks.indexOf(task)] = {...task, status: 'done', updatedAt: 8};
    const closed = await f.invoke() as {status: number; body: {tasks: unknown[]}};
    expect(closed.body.tasks).toContainEqual(expect.objectContaining({id: task.id, closure: 'satisfied', revision: 8}));
  } finally {await f.close();}
});

test('the original browser accepted-result operation has an owner webhook declaration', () => {
  const declaration = manifest.contributions.find((c: {path?: string}) => c.path === 'connections/:connectionId/work/result/accepted');
  expect(declaration).toMatchObject({type: 'webhook', methods: ['POST'], action: {method: 'collective.work.control.http'}});
  expect(manifest.features.find((f: {id: string}) => f.id === 'collective-work').contributions)
    .toContainEqual({type: 'webhook', id: declaration.id});
});

test('owner thread candidates are read completely across the Host single-request bound', async () => {
  const ids = Array.from({ length: 5_001 }, (_, index) => `thread-${index}`);
  const batchSizes: number[] = [];
  const summary = (id: string) => ({
    id,
    title: id,
    deepLinkUrl: `/thread/${id}`,
    createdAt: 1,
    lastActiveAt: 1,
    preferredCats: [],
    featureRefs: [],
  });
  const rows = await readCollectiveOwnerThreadCandidates({
    async list({ threadIds }) {
      batchSizes.push(threadIds.length);
      expect(threadIds.length).toBeLessThanOrEqual(1_000);
      return threadIds.map(summary);
    },
    async get(id) { return summary(id); },
    async getCats() { return { participants: [], routableNow: [], routableNotJoined: [], notRoutable: [] }; },
  }, ids, async () => {});
  expect(batchSizes).toEqual([1_000, 1_000, 1_000, 1_000, 1_000, 1]);
  expect(rows).toHaveLength(ids.length);
  expect(rows[0]?.id).toBe(ids[0]);
  expect(rows.at(-1)?.id).toBe(ids.at(-1));
});

async function setup(taskHost?: ModulePluginHostShape['tasks']) {
  const f = await fixture(); let stale = false, reads = 0, bodyReads = 0;
  let threadListReads = 0, threadGetReads = 0, threadCatReads = 0;
  let deliveryStatus: 'queued'|'delivered'|'canceled'|undefined;
  const current = async () => { if (stale) throw new Error('Owner view expired'); };
  const sourceMessageId = 'view-source';
  await f.connector.sync(f.connection.connectionId);
  const route = (await f.connector.getHostRoute(f.connection.connectionId))!;
  await f.connector.beginInboxRouting(f.connection.connectionId, f.source.eventId, route.revision);
  await f.connector.completeInboxRouting(f.connection.connectionId, f.source.eventId, route.revision,
    { kind: 'thread_message', messageId: sourceMessageId, threadId: 'channel', catId: 'codex-sol' });
  const rows = [{ id: 'channel', title: 'Owner channel', createdBy: 'local-owner', participants: ['codex-sol'] },
    { id: 'foreign', title: 'Foreign private', createdBy: 'foreign-owner', participants: ['codex-sol'] }];
  const subscriptions = new Set<string>();
  const unused = async (): Promise<never> => { throw new Error('Read must not invoke an unrelated Host port'); };
  const base: PluginTaskReadItem = { id: 'owned-task', title: 'Original entrusted work', threadId: 'channel',
    kind: 'work', subjectKey: null, status: 'doing', ownerCatId: null, why: '', createdBy: 'local-owner',
    createdAt: 1, updatedAt: 1, userId: 'local-owner',
    entrustedWork: { revision: 3, closure: { state: 'open' }, admission: { sourceRefs: [`message:${sourceMessageId}`] } } };
  const tasks: PluginTaskReadItem[] = [base, { ...base, id: 'foreign-task', userId: 'foreign-owner' },
    { ...base, id: 'unrelated-task', entrustedWork: { ...base.entrustedWork!, admission: { sourceRefs: ['message:other'] } } },
    { ...base, id: 'legacy-unowned-task', userId: null }];
  const host: ModulePluginHostShape = {members:{list:async()=>[{catId:'codex-sol',displayName:'Sol',defaultModel:'fixture',available:true}],get:async()=>null}, pluginInstanceId: 'installed-instance', dataPath: f.root, config: serviceHostConfig(), secrets: { async get() { return undefined; } }, storage: memoryStorage(),
    streams:{read:async function*(){throw new Error('Unused stream port');}}, messaging: { send: unused, async get(id){bodyReads++;return {id,userId:'local-owner',threadId:'channel',catId:null,content:'ordinary source',mentions:[],timestamp:0,sourceRevision:'fixture',source:{connector:'collective',label:'Collective',icon:'collective',meta:{participation:f.source}},...(deliveryStatus?{deliveryStatus}:{})};},
      async subscribe({threadId}) {expect(rows.find(row => row.id === threadId)?.createdBy).toBe('local-owner');subscriptions.add(threadId);},
      async unsubscribe({threadId}) {subscriptions.delete(threadId);}}, log() {},
    tasks: taskHost ?? { get: unused, create: unused, update: unused,
      bindDataController: unused, revokeDataController: unused,
      async list(filter) { await current(); expect(filter).toEqual({kind:'work'}); reads++; return tasks; } },
    threads: { async get(id){threadGetReads++;const row=rows.find(row=>row.id===id&&row.createdBy==='local-owner');return row?{id:row.id,title:row.title,deepLinkUrl:'/thread/'+row.id,createdAt:0,lastActiveAt:0,preferredCats:[],featureRefs:[]}:null;},readMessages: unused,async getCats(id){threadCatReads++;return {participants:(rows.find(row=>row.id===id)?.participants??[]).map(catId=>({catId,displayName:catId,aliases:[],lastMessageAt:0,messageCount:0})),routableNow:[],routableNotJoined:[],notRoutable:[]};},create: unused,update: unused,addParticipants:unused,
      async list(options: { limit?: number; before?: { lastActiveAt: number; id: string }; threadIds?: readonly string[] } = {}) {
      threadListReads++; await current(); return rows.filter(r=>r.createdBy==='local-owner' && (!options.threadIds || options.threadIds.includes(r.id))).map((r, i) => ({ ...r, deepLinkUrl: '/thread/' + r.id, createdAt: 1,
        lastActiveAt: rows.length - i, preferredCats: [], featureRefs: [] }))
        .filter(r => !options.before || r.lastActiveAt < options.before.lastActiveAt ||
          (r.lastActiveAt === options.before.lastActiveAt && r.id > options.before.id)).slice(0, options.limit ?? 50);
    } },
     };
  let active = await entrypoint.create(manifest).start(host);
  // Work activation restores subscriptions with a permitted metadata read.
  // The counters below measure only the subsequent owner HTTP request.
  reads = 0; threadListReads = 0; threadGetReads = 0; threadCatReads = 0;
  const resetReads = () => { reads = 0; threadListReads = 0; threadGetReads = 0; threadCatReads = 0; };
  return { ...f, get active() {return active;}, tasks, rows, subscriptions, async restart() {await active.stop({reason:'test'});active = await entrypoint.create(manifest).start(host);resetReads();}, get reads() { return reads; }, get bodyReads() { return bodyReads; },
    get threadReads() { return { list: threadListReads, get: threadGetReads, getCats: threadCatReads }; }, setDeliveryStatus(status: typeof deliveryStatus) { deliveryStatus = status; }, expire() { stale = true; },
    invoke(owner = 'local-owner', native?: unknown) { return active.actions['collective.control.http']!({ request: { method: 'GET',
      path: `connections/${f.connection.connectionId}/participation`, headers: { origin: 'http://localhost:5172' },
      principal: { kind: 'owner', id: owner } } }, native as never, ownerCaller(owner,'GET',current)); }, async close() { await active.stop({reason:'test'}); await f.close(); } };
}
test('retained GET participation is declared by its owning feature', () => {
  const c = manifest.contributions.find((c: { path?: string }) => c.path === 'connections/:connectionId/participation');
  expect(c).toMatchObject({ type: 'webhook', methods: ['GET', 'PUT'], action: { method: 'collective.control.http' } });
  expect(manifest.features[0].contributions).toContainEqual({ type: 'webhook', id: c.id });
});
test('actual GET retains owner threads, requests, admitted-source Task filtering and policy without mutation', async () => {
  const f = await setup(); try {
    const before = await f.connector.getHostRoute(f.connection.connectionId);
    const result = await f.invoke() as { status: number; body: any };
    expect(result.status, JSON.stringify(result)).toBe(200);
    expect(result.body).toMatchObject({ connection: { connectionId: f.connection.connectionId }, revision: before!.revision,
      cats: [{ id: 'codex-sol', configured: true, eligible: true }], threads: [{ id: 'channel', title: 'Owner channel', participants: ['codex-sol'] }],
      requests: [{ messageId: 'view-source', privateThread: { id: 'channel', title: 'Owner channel' } }],
      tasks: [{ id: 'owned-task', revision: 3, closure: 'open', sourceRefs: ['message:view-source'] }] });
    expect(result.body.tasks).toHaveLength(1); expect(result.body.threads).toHaveLength(1);
    expect(result.body.requests[0]).not.toHaveProperty('execution'); // Current Host omits queue facts: no fabricated progress.
    expect(await f.connector.getHostRoute(f.connection.connectionId)).toEqual(before); expect(f.reads).toBe(1);
  } finally { await f.close(); }
});
test('foreign owner and native caller are refused before owner view reads', async () => {
  const f = await setup(); try {
    expect(await f.invoke('foreign-owner')).toMatchObject({ status: 403, body: { code: 'CONNECTOR_OWNER_MISMATCH' } });
    await expect(f.invoke('local-owner', { userId: 'local-owner' })).rejects.toThrow(/webhook|owner HTTP/);
    expect(f.reads).toBe(0);
  } finally { await f.close(); }
});
test('expired view and disposed feature cannot return cached owner data', async () => {
  const f = await setup(); try {
    f.expire(); await expect(f.invoke()).rejects.toThrow(/expired/);
    expect(f.reads).toBe(0);
  } finally { await f.close(); }
});
test('unrelated private threads do not amplify the participation owner read', async () => {
  const f = await setup(); try {
    for (let i = 0; i < 120; i++) f.rows.push({ id: `unrelated-${i}`, title: `Unrelated ${i}`, createdBy: 'local-owner', participants: [] });
    const result = await f.invoke() as { status: number; body: { threads: { id: string }[] } };
    expect(result.status).toBe(200);
    expect(result.body.threads.map(thread => thread.id)).toEqual(['channel']);
    expect(f.threadReads).toEqual({ list: 1, get: 1, getCats: 1 });
  } finally { await f.close(); }
});
test('ordinary source delivery facts distinguish queued/canceled without claiming Cat execution', async () => {
 const f=await fixture();try {
 await f.connector.sync(f.connection.connectionId);
 const item=(await f.connector.listInbox(f.connection.connectionId)).find(row=>row.event.eventId===f.source.eventId)!;
 const request={...item,routeReceipt:{kind:'thread_message' as const,threadId:'channel',messageId:'source',catId:'codex-sol'}};
 const thread={id:'channel',title:'Owner',participants:['codex-sol']};
 const message={id:'source',catId:null,content:'source',mentions:[],timestamp:0,sourceRevision:'fixture',userId:'local-owner',threadId:'channel',source:{connector:'collective',label:'Collective',icon:'collective',meta:{participation:f.source}},deliveryStatus:'queued' as 'queued'|'delivered'|'canceled'};
 const read=()=>ownerRequestExecution(request,thread,{async getById(){return message;}},'local-owner',f.connection.connectionId);
 expect(await read()).toEqual({stage:'queued'});
 message.deliveryStatus='delivered';expect(await read()).toBeUndefined();
 message.deliveryStatus='canceled';expect(await read()).toEqual({stage:'failed'});
 message.userId='foreign-owner';expect(await read()).toBeUndefined();message.userId='local-owner';
 expect(await ownerRequestExecution(request,thread,{async getById(){return message;}},'local-owner','other-connection')).toBeUndefined();
 }finally{await f.close();}
});

test('an absent stable Task owner projection fails visibly instead of returning an empty owner view', async () => {
  const f = await setup(); try {
    const legacy = { ...f.tasks[0]! };
    Reflect.deleteProperty(legacy, 'userId');
    f.tasks[0] = legacy;
    const response = await f.invoke() as { status: number; body: { error?: string } };
    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toMatch(/Task read.*userId/);
  } finally { await f.close(); }
});

// Cross-repository acceptance explicitly supplies the reviewed compiled Host module.
// Ordinary package tests exercise the same declared projection using the typed fixture above.
if (process.env.C1_TASK_READ_HOST_MODULE) test('compiled Host four read ports cross the SDK and preserve the original owner Task summary', async () => {
  const { createPluginTaskHost } = await import(process.env.C1_TASK_READ_HOST_MODULE!);
  const fullAdmission={basis:'authorized_source' as const,sourceRefs:['message:view-source'],
    authorityRef:'message:original-admission',idempotencyKey:'host-admission',receiptRef:'task:receipt:host-admission',
    admittedAt:1};
  const base: PluginTaskReadItem = { id: 'actual-host-task', title: 'Original entrusted work', threadId: 'channel', kind: 'work',
    subjectKey: 'work:fixture', status: 'doing', ownerCatId: 'codex-sol', why: '', createdBy: 'local-owner', createdAt: 1,
    updatedAt: 1, userId: 'local-owner', pluginWait: { pluginInstanceId: 'installed-instance', generation: 2,
      await: { generation: 2, expiresAt: 9000 }, waitOutcome: { outcomeId: 'outcome-1', generation: 1,
        ownerFence: { kind: 'containing_task', generation: 1 }, reason: 'matched', delivery: 'delivered' } }, entrustedWork: { revision: 3, artifactRefs:[],closure: { state: 'open' },
      admission: fullAdmission,dataController:{bindingRevision:1,
        state:'active',currentForCaller:true,binding:{userId:'local-owner',catId:'codex-sol',threadId:'channel',subjectKey:'work:fixture',
          firstSourceRef:'message:view-source',admissionAuthorityRef:'message:original-admission',pluginId:'official.collective-connector',
          pluginInstanceId:'installed-instance',moduleRef:'plugin:official.collective-connector',lifecycleRevision:8,
          ownerOperationReceiptRef:`task-data-controller:${'a'.repeat(64)}`}} } };
  const publicBase:PluginTaskReadItem={...base,entrustedWork:{...base.entrustedWork!,
    admission:{sourceRefs:fullAdmission.sourceRefs,authorityRef:fullAdmission.authorityRef}}};
  const raw = { ...base, privateHostField: 'not-visible', pluginWait: { ...base.pluginWait!,
    invalidated: true, userId: 'private-owner', catId: 'private-cat', threadId: 'private-thread',
    registration: { invocationId: 'private-invocation', source: { content: 'private-source' } },
    await: { ...base.pluginWait!.await!, registration: { source: 'private-await-source' } },
    waitOutcome: { ...base.pluginWait!.waitOutcome!, ownerFence: { ...base.pluginWait!.waitOutcome!.ownerFence, source: 'private-fence' } } }, entrustedWork: { ...base.entrustedWork!,
    admission: { ...base.entrustedWork!.admission, ownerReceipt: 'not-authority' }, execution: { grant: 'not-visible' } } };
  const legacy = { ...base, id: 'legacy-unowned' };
  Reflect.deleteProperty(legacy, 'userId'); Reflect.deleteProperty(legacy, 'entrustedWork');
  const taskHost: ModulePluginHostShape['tasks'] = createPluginTaskHost({ pluginId: 'official.collective-connector',
    pluginInstanceId:'installed-instance',ownerUserId: 'local-owner', readThreadStore: { async get(id: string) { return { id, createdBy: 'local-owner' }; } },
    admission:{readCurrentDataControllerAuthority:async()=>({
      pluginId:'official.collective-connector',pluginInstanceId:'installed-instance',moduleRef:'plugin:official.collective-connector',
      lifecycleRevision:8}),
      withCurrentDataControllerAuthority:async(run:(value:unknown)=>unknown)=>run({
      pluginId:'official.collective-connector',pluginInstanceId:'installed-instance',moduleRef:'plugin:official.collective-connector',
      lifecycleRevision:8}),assertCurrent:async()=>{},
      messageStore:{},isCatAvailable:()=>true},taskStore: { async get() { return raw; }, async getBySubject() { return raw; },
      async listByThread() { return [raw, legacy]; }, async listByKind() { return [raw, legacy]; } } });
  const results = [await taskHost.get({ id: raw.id }), await taskHost.get({ subjectKey: 'work:fixture' }),
    ...(await taskHost.list({ threadId: 'channel' })), ...(await taskHost.list({ kind: 'work' }))];
  expect(results.filter(row => row?.id === raw.id)).toHaveLength(4);
  expect(results.filter(row => row?.id === legacy.id)).toHaveLength(2);
  for (const result of results.filter(row => row?.id === raw.id)) expect(result).toEqual(publicBase);
  for (const result of results.filter(row => row?.id === legacy.id)) expect(result!.userId).toBeNull();
  const f = await setup(taskHost); try {
    const response = await f.invoke() as { status: number; body: { tasks: unknown[] } };
    expect(response.status, JSON.stringify(response)).toBe(200);
    expect(response.body.tasks).toEqual([{ id: raw.id, title: raw.title, threadId: 'channel', status: 'doing',
      revision: 3, closure: 'open', sourceRefs: ['message:view-source'] }]);
  } finally { await f.close(); }
});


test('actual owner GET reads ordinary delivery state and does not fabricate execution phases',async()=>{
 const f=await setup();try{
 const stage=async()=>{const response=await f.invoke() as {status:number;body:{requests:{execution?:{stage:string}}[]}};expect(response.status).toBe(200);return response.body.requests[0]!.execution?.stage;};
 f.setDeliveryStatus('queued');expect(await stage()).toBe('queued');
 f.setDeliveryStatus('delivered');expect(await stage()).toBeUndefined();
 f.setDeliveryStatus('canceled');expect(await stage()).toBe('failed');
 f.setDeliveryStatus(undefined);expect(await stage()).toBeUndefined();
 expect(f.bodyReads).toBeGreaterThan(0);
 }finally{await f.close();}
});

test('private queue witnesses cannot fabricate public delivery or Cat execution', async () => {
  const f = await fixture(); try {
    await f.connector.sync(f.connection.connectionId);
    const item = (await f.connector.listInbox(f.connection.connectionId)).find(item => item.event.eventId === f.source.eventId)!;
    const catId = 'toString';
    const recipient = item.event.recipient; if (recipient?.kind !== 'agent') throw new Error('Expected original Agent recipient');
    const request = { ...item, event: { ...item.event, recipient: { ...recipient, agentId: catId } },
      routeReceipt: { kind: 'thread_message' as const, threadId: 'channel', messageId: 'source', catId } };
    const thread = { id: 'channel', title: 'Owner', createdBy: 'local-owner', participants: [catId] };
    const message = { id: 'source', catId: null, content: 'source', mentions: [], timestamp: 0, sourceRevision: 'fixture', userId: 'local-owner', threadId: 'channel',
      source: { connector: 'collective', label: 'Collective', icon: 'collective', meta: { participation: { ...f.source, catId } } },
      queueCustody: { status: 'queued' as const, allTargetCats: [catId], handledByCatIds: [], failedByCatIds: [],
        seenByCatIds: [], targetOutcomeByCatId: {} } };
    expect(await ownerRequestExecution(request, thread, { async getById() { return message; } },
      'local-owner', f.connection.connectionId)).toBeUndefined();
  } finally { await f.close(); }
});

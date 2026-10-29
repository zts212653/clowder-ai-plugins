import assert from 'node:assert/strict';
import test from 'node:test';
import { hostRouteConfigSchema } from '../src/business/connector/host-route-state.js';
import * as moved from '../src/participation-reconciler.js';
function fixture(initialExcludedCatIds: readonly string[] = ['b']) {
  assert.equal(typeof moved.createCollectiveParticipationCaller, 'function', 'the original reconciler must be moved and paired');
  const calls: unknown[] = []; let expired = false;
  const threads = new Map<string, { id: string; createdBy: string; participants: string[] }>();
  let route: any, rows = [
    { catId: 'a', displayName: 'Cat A', defaultModel: 'model', available: true, roleDescription: ' Role ', avatar: 'data:image/webp;base64,UklGRg==' },
    { catId: 'b', displayName: 'Cat B', defaultModel: 'model', available: false },
  ];
  const ownerThreads = {
    async get(id: string) { calls.push(['get', id]); return threads.get(id) ?? null; },
    async create(input: { title: string }) { calls.push(['create', input]); const value = { id: 'thread-' + threads.size, createdBy: 'owner', participants: [] as string[] }; threads.set(value.id, value); return { ...value }; },
    async addParticipants(input: { threadId: string; catIds: readonly string[] }) { calls.push(['add', input]); const value = threads.get(input.threadId)!; value.participants.push(...input.catIds); return value; },
  };
  const connector = {
    async setHostRoute(id: string, next: unknown, revision: number) { calls.push(['route', id, revision]); route = { ...(next as object), connectionId: id, revision: revision + 1, updatedAt: '2030-01-01T00:00:00.000Z', scopeStarts: {} }; return route; },
    async publishParticipation(id: string) { calls.push(['publish', id]); },
  };
  const summary=(row:{id:string})=>({...row,title:null,deepLinkUrl:'/thread/'+row.id,createdAt:0,lastActiveAt:0,preferredCats:[],featureRefs:[]});
  const currentThreads: import('@clowder-ai/plugin-sdk').PluginThreadHost = {async get(id){const row=await ownerThreads.get(id);return row?summary(row):null;},async create(input){return summary(await ownerThreads.create(input));},async addParticipants(input){return summary(await ownerThreads.addParticipants(input));},async getCats(id){return {participants:(threads.get(id)?.participants??[]).map(catId=>({catId,displayName:catId,aliases:[],lastMessageAt:0,messageCount:0})),routableNow:[],routableNotJoined:[],notRoutable:[]};},async list(){return [];},async update(){throw new Error('Unused');},async readMessages(){throw new Error('Unused');}};
  const caller = moved.createCollectiveParticipationCaller({ ownerUserId: 'owner', threads:currentThreads, async assertCurrent() { if (expired) throw new Error('Caller is no longer current'); },
    members: { async list() { calls.push(['members']); return rows; },async get(id){return rows.find(row=>row.catId===id)??null;} }, connector: connector as never });
  const reconcile = () => caller.reconcile({ connectionId: 'con_aaaaaaaa', expectedRevision: route?.revision ?? 0, route,
    channelIds: ['z', 'general', 'general'], initialExcludedCatIds });
  return { calls, caller, reconcile, threads, ownerThreads, get route() { return route; }, expire() { expired = true; }, connector, updateRows(value: typeof rows) { rows = value; } };
}
test('reconciler preserves initial exclusions and sorted channel routes using strict owner thread and honest public roster', async () => {
  const f = fixture(), route = await f.reconcile();
  assert.deepEqual(Object.keys(route.channelRoutes), ['general', 'z']);
  assert.deepEqual(route.desiredParticipation.excludedCatIds, ['b']);
  assert.equal(route.observedEligibility.a.eligible, true); assert.equal(route.observedEligibility.b.eligible, false);
  assert.deepEqual(Object.keys(route.channelRoutes.general.participants), ['a']);
  assert.deepEqual(route.publicProfiles.a, { description: 'Role', avatarDataUrl: 'data:image/webp;base64,UklGRg==' });
  assert.equal(route.publicProfiles.b, undefined);
  assert.equal(route.localOwnerUserId, 'owner'); assert.equal(route.defaultIngressThreadId, route.channelRoutes.general.threadId);
  assert.deepEqual(f.calls.filter(call => Array.isArray(call) && call[0] === 'create'), [['create', { title: 'Collective #general 公共参与' }], ['create', { title: 'Collective #z 公共参与' }]]);
  assert.deepEqual(f.calls.filter(call => Array.isArray(call) && call[0] === 'members'), [['members']]);
});
test('default participation follows Host enable switches while retaining disabled members and thread history', async () => {
  const f = fixture([]), first = await f.reconcile();
  assert.deepEqual(Object.keys(first.channelRoutes.general.participants), ['a']);
  assert.equal(first.observedEligibility.b.configured, true);
  assert.equal(first.observedEligibility.b.eligible, false);
  f.updateRows([
    { catId: 'a', displayName: 'Cat A', defaultModel: 'model', available: false },
    { catId: 'b', displayName: 'Cat B', defaultModel: 'model', available: true },
  ]);
  const next = await f.reconcile();
  assert.deepEqual(Object.keys(next.channelRoutes.general.participants), ['b']);
  assert.equal(next.observedEligibility.a.configured, true);
  assert.equal(next.observedEligibility.a.eligible, false);
  assert.equal(next.publicProfiles.a, undefined);
  assert.deepEqual(Object.keys(next.publicProfiles), ['b']);
  assert.equal(next.channelRoutes.general.threadId, first.channelRoutes.general.threadId);
  assert.deepEqual(f.threads.get(next.channelRoutes.general.threadId)!.participants, ['a', 'b']);
});
test('same reconciler input retains routes/threads and still publishes participation without reissuing create', async () => {
  const f = fixture(), first = await f.reconcile(); const count = f.calls.length;
  const second = await f.reconcile(); assert.equal(second, first);
  assert.equal(f.threads.size, 2);
  assert.equal(f.calls.slice(count).some(call => Array.isArray(call) && ['create', 'route', 'add'].includes(call[0])), false);
  assert.deepEqual(f.calls.at(-1), ['publish', 'con_aaaaaaaa']);
});
test('updated roster is reread and removed cats become unconfigured/ineligible without deleting history', async () => {
  const f = fixture(); await f.reconcile(); f.updateRows([]); const route = await f.reconcile();
  assert.equal(route.observedEligibility.a.configured, false); assert.equal(route.observedEligibility.a.eligible, false);
  assert.equal(route.observedEligibility.a.displayName, 'Cat A（model）');
  assert.deepEqual(route.channelRoutes.general.participants, {}); assert.deepEqual(route.publicProfiles, {});
  assert.equal(f.threads.size, 2); assert.deepEqual(f.threads.get(route.channelRoutes.general.threadId)!.participants, ['a']);
});
test('reconciler revision conflict and empty channels fail before thread or Connector mutation', async () => {
  const f = fixture(); await f.reconcile(); const count = f.calls.length;
  await assert.rejects(() => f.caller.reconcile({ connectionId: 'con_aaaaaaaa', route: f.route, expectedRevision: 0, channelIds: ['general'] }), (e: any) => e.code === 'PARTICIPATION_REVISION_CONFLICT');
  await assert.rejects(() => f.caller.reconcile({ connectionId: 'con_aaaaaaaa', route: f.route, expectedRevision: f.route.revision, channelIds: [] }), (e: any) => e.code === 'INVALID_PARTICIPATION_REQUEST');
  assert.equal(f.calls.slice(count).some(call => Array.isArray(call) && ['create', 'route', 'add', 'publish'].includes(call[0])), false);
});
test('strict owner create refusal is preserved once and no accessible-thread fallback or route commit follows', async () => {
  const f = fixture(), refusal = new Error('DELIVERY_REJECTED'); let count = 0;
  f.ownerThreads.create = async () => { count++; throw refusal; };
  await assert.rejects(f.reconcile, error => error === refusal);
  assert.equal(count, 1); assert.equal(f.route, undefined);
});
test('reconciliation has no arbitrary avatar file read and omits raw private paths', async () => {
  assert.equal(typeof moved.reconcileParticipation, 'function');
  let projected: any;
  await moved.reconcileParticipation({ ownerUserId: 'owner', connectionId: 'con_aaaaaaaa', expectedRevision: 0, channelIds: ['general'],
    cats: [{ id: 'a', displayName: 'Cat', supported: true, avatar: '/Users/private/file.webp' }],
    threads: { async get() { return null; }, async create() { return { id: 'thread', participants: [] }; }, async addParticipants() {} },
    connector: { async setHostRoute(id, value, revision) { projected = value; assert.equal(typeof revision, 'number'); return hostRouteConfigSchema.parse({ ...value, connectionId: id, revision: revision! + 1, updatedAt: '2030-01-01T00:00:00.000Z', scopeStarts: {} }); }, async publishParticipation() {} },
  });
  assert.deepEqual(projected.publicProfiles, { a: {} }); assert.equal(JSON.stringify(projected).includes('/Users/private'), false);
});

test('expired caller is refused before any roster or thread effects', async () => {
  const f = fixture(); f.expire();
  await assert.rejects(f.reconcile, /no longer current/); assert.deepEqual(f.calls, []);
});
test('revocation after route commit suppresses publication and never retries or claims rollback', async () => {
  const f = fixture(), original = f.connector.setHostRoute;
  f.connector.setHostRoute = async (...args) => { const result = await original(...args); f.expire(); return result; };
  await assert.rejects(f.reconcile, /no longer current/);
  assert.equal(f.route.revision, 1, 'the already committed route is not falsely rolled back');
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'route').length, 1);
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'publish'), false);
});

test('original hundred-cat roster closes over the actual fifty-item owner thread port without changing business eligibility', async () => {
  const f = fixture(); f.updateRows(Array.from({ length: 100 }, (_, i) => ({ catId: 'cat-' + i, displayName: 'Cat ' + i, defaultModel: 'model', available: true })));
  const original = f.ownerThreads.addParticipants;
  f.ownerThreads.addParticipants = async input => { assert.ok(input.catIds.length <= 50, 'actual ownerThreads port maxItems50'); return original(input); };
  const route = await f.reconcile();
  assert.equal(Object.keys(route.channelRoutes.general.participants).length, 100);
  assert.equal(f.threads.get(route.channelRoutes.general.threadId)!.participants.length, 100);
  assert.deepEqual(f.calls.filter(call => Array.isArray(call) && call[0] === 'add').map((call: any) => call[1].catIds.length), [50, 50, 50, 50]);
});

test('revocation between participant batches preserves the completed Host effect and stops without retry or route publication', async () => {
  const f = fixture(); f.updateRows(Array.from({ length: 100 }, (_, i) => ({ catId: 'cat-' + i, displayName: 'Cat ' + i, defaultModel: 'model', available: true })));
  const original = f.ownerThreads.addParticipants;
  f.ownerThreads.addParticipants = async input => { const result = await original(input); f.expire(); return result; };
  await assert.rejects(f.reconcile, /no longer current/);
  assert.equal(f.threads.size, 1); assert.equal([...f.threads.values()][0]!.participants.length, 50);
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === 'add').length, 1);
  assert.equal(f.route, undefined); assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === 'publish'), false);
});

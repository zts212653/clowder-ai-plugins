import {memoryStorage, serviceHostConfig, ownerAction} from '../../../../test/runtime-fixture.js';
import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { PluginMemberHost, ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import entrypoint from '../../../plugin-entrypoint.js';
import { fixture } from './communication-work-custody.fixture.js';

const manifest = parse(await readFile(new URL('../../../../plugin.yaml', import.meta.url), 'utf8'));
const request = (connectionId: string, body: unknown, owner = 'local-owner', method = 'PUT') => ({ request: {
  method, path: `connections/${connectionId}/participation/policy`, body, headers: { origin: 'http://localhost:5172' },
  principal: { kind: 'owner', id: owner },
} });
async function setup(clearAgentRoutes = false, actualRoster?: PluginMemberHost, module = entrypoint) {
  const f = await fixture();
  if (clearAgentRoutes) {
    const prior = (await f.connector.getHostRoute(f.connection.connectionId))!;
    await f.connector.setHostRoute(f.connection.connectionId, { localOwnerUserId: prior.localOwnerUserId, defaultIngressThreadId: prior.defaultIngressThreadId, humanNotificationThreadId: prior.humanNotificationThreadId, agentRoutes: {} }, prior.revision);
  }
  const threads = new Map<string, { id: string; createdBy: string; participants: string[] }>([
    ['channel', { id: 'channel', createdBy: 'local-owner', participants: ['codex-sol'] }],
  ]);
  let creates = 0, stale = false;
  const quota = new Map([['codex-sol', true]]);
  const roster = [{ catId: 'codex-sol', displayName: 'Sol', defaultModel: 'fixture', available: true }];
  const summary = (row: {id:string}) => ({id:row.id,title:null,deepLinkUrl:'/thread/'+row.id,createdAt:1,lastActiveAt:1,preferredCats:[],featureRefs:[]});
  const members: PluginMemberHost = actualRoster ?? {async list(){return roster.map(row=>({...row,available:quota.get(row.catId)??false}));},async get(id){return (await this.list()).find(row=>row.catId===id)??null;}};
  const host: ModulePluginHostShape = {members, pluginInstanceId: 'installed-instance', dataPath: f.root,
    config: serviceHostConfig(), secrets: { async get() { return undefined; } },
    storage: memoryStorage(), tasks: {list: async () => []} as never, threads: {async get(id){const row=threads.get(id);return row?.createdBy==='local-owner'?summary(row):null;},async getCats(id){return {participants:(threads.get(id)?.participants??[]).map(catId=>({catId,displayName:catId,aliases:[],lastMessageAt:0,messageCount:0})),routableNow:[],routableNotJoined:[],notRoutable:[]};},async create(input){const row={id:'owner-thread-'+(++creates),createdBy:'local-owner',participants:[...(input.participants??[])]};threads.set(row.id,row);return summary(row);},async addParticipants(input){const row=threads.get(input.threadId)!;row.participants.push(...input.catIds);return summary(row);},async list(){return [];},async update(){throw new Error('Unused');},async readMessages(){throw new Error('Unused');}}, streams:{read:async function*(){throw new Error('Unused stream port');}}, messaging: {} as never, log() {},

  };
  const active = await module.create(manifest).start(host);
  const route = async () => JSON.parse(await readFile(join(f.root, 'connector/collective-connector.json'), 'utf8')).hostRoutes[f.connection.connectionId];
  return { ...f, active, threads, route, roster, quota, async current(){if(stale)throw new Error('Owner request expired');}, expire() { stale = true; }, get creates() { return creates; }, async close() { await active.stop({reason:'test'}); await f.close(); } };
}
const policy = (excluded: string[] = []) => ({ defaultMode: 'include', excludedCatIds: excluded,
  channelOverrides: { general: { excludedCatIds: [] } } });

test('retained PUT participation/policy is declared in the owning feature', () => {
  const contribution = manifest.contributions.find((c: { path?: string }) => c.path === 'connections/:connectionId/participation/policy');
  expect(contribution).toMatchObject({ type: 'webhook', methods: ['PUT'], action: { method: 'collective.control.http' } });
  expect(manifest.features[0].contributions).toContainEqual({ type: 'webhook', id: contribution.id });
});
test('actual module retains owner exclusions and exact route revision across policy changes without new native or Task authority', async () => {
  const f = await setup();
  try {
    const invoke = ownerAction(f.active.actions['collective.control.http']!, 'local-owner', f.current);
    const before = await f.route();
    const excluded = await invoke(request(f.connection.connectionId, { expectedRevision: before.revision, channelIds: ['general'], policy: policy(['codex-sol']) }));
    expect(excluded).toMatchObject({ status: 200, body: { published: true } });
    const after = await f.route();
    expect(after.desiredParticipation.excludedCatIds).toEqual(['codex-sol']);
    expect(after.channelRoutes.general.participants).toEqual({});
    const threadId = after.channelRoutes.general.threadId;
    const included = await invoke(request(f.connection.connectionId, { expectedRevision: after.revision, channelIds: ['general'], policy: policy() }));
    expect(included).toMatchObject({ status: 200 });
    const restored = await f.route();
    expect(restored.channelRoutes.general.threadId).toBe(threadId);
    expect(restored.channelRoutes.general.participants).toHaveProperty('codex-sol');
    expect(restored.agentRoutes).toEqual(before.agentRoutes);
    expect(f.creates).toBe(1);
  } finally { await f.close(); }
});
test('actual module refuses stale revision, foreign owner and body identity before changing policy or threads', async () => {
  const f = await setup();
  try {
    const invoke = ownerAction(f.active.actions['collective.control.http']!, 'local-owner', f.current), before = await f.route();
    const input = { expectedRevision: before.revision, channelIds: ['general'], policy: policy() };
    expect(await ownerAction(f.active.actions['collective.control.http']!, 'foreign-owner', f.current)(request(f.connection.connectionId, input, 'foreign-owner'))).toMatchObject({ status: 403, body: { code: 'CONNECTOR_OWNER_MISMATCH' } });
    expect(await invoke(request(f.connection.connectionId, { ...input, expectedRevision: before.revision + 1 }))).toMatchObject({ status: 409, body: { code: 'PARTICIPATION_REVISION_CONFLICT' } });
    expect(await invoke(request(f.connection.connectionId, { ...input, userId: 'local-owner' }))).toMatchObject({ status: 400, body: { code: 'INVALID_PARTICIPATION_REQUEST' } });
    expect(await f.route()).toEqual(before); expect(f.creates).toBe(0);
  } finally { await f.close(); }
});
test('actual module keeps PUT policy and POST reconcile distinct and rejects native/Settings contexts', async () => {
  const f = await setup();
  try {
    const invoke = ownerAction(f.active.actions['collective.control.http']!, 'local-owner', f.current), before = await f.route();
    const input = { expectedRevision: before.revision, channelIds: ['general'], policy: policy() };
    expect(await invoke(request(f.connection.connectionId, input, 'local-owner', 'POST'))).toMatchObject({ status: 405 });
    await expect(invoke(request(f.connection.connectionId, input), { userId: 'local-owner' } as never)).rejects.toThrow(/webhook|owner HTTP/);
    await expect(invoke(request(f.connection.connectionId, input), undefined, { kind: 'owner-operation' } as never)).rejects.toThrow();
    expect(await f.route()).toEqual(before); expect(f.creates).toBe(0);
  } finally { await f.close(); }
});

const individualRequest = (id: string, body: unknown, owner = 'local-owner') => ({ request: {
  method: 'PUT', path: `connections/${id}/participation`, body, headers: { origin: 'http://localhost:5172' },
  principal: { kind: 'owner', id: owner },
} });
const individualInput = (revision: number, enabled = true) => ({ catId: 'codex-sol', enabled,
  expectedRevision: revision, channelIds: ['general'], standingWork: { requestingHumanIds: ['requesting-human'], expiresAt: null } });

test('original individual participation PUT is declared alongside retained owner GET', () => {
  const c = manifest.contributions.find((c: { path?: string }) => c.path === 'connections/:connectionId/participation');
  expect(c).toMatchObject({ methods: ['GET', 'PUT'], action: { method: 'collective.control.http' } });
});
test('actual module preserves individual participation, standing-work scope and owner thread across disable/restore', async () => {
  const f = await setup(); try {
    const invoke = ownerAction(f.active.actions['collective.control.http']!, 'local-owner', f.current);
    const before = await f.route(), key = `${f.owner.human.humanId}:codex-sol`;
    expect(await invoke(individualRequest(f.connection.connectionId, individualInput(before.revision)))).toMatchObject({ status: 200, body: { published: true } });
    const enabled = await f.route();
    expect(enabled.agentRoutes[key]).toMatchObject({ catId: 'codex-sol', threadId: 'channel', participation: { channelIds: ['general'] },
      standingWork: { channelIds: ['general'], requestingHumanIds: ['requesting-human'], expiresAt: null } });
    expect(enabled.agentRoutes[key].standingWorkRevision).toBeGreaterThan(0);
    expect(await invoke(individualRequest(f.connection.connectionId, individualInput(enabled.revision, false)))).toMatchObject({ status: 200 });
    const disabled = await f.route(); expect(disabled.agentRoutes[key]).toEqual({ catId: 'codex-sol', threadId: 'channel' });
    expect(await invoke(individualRequest(f.connection.connectionId, individualInput(disabled.revision)))).toMatchObject({ status: 200 });
    const restored = await f.route(); expect(restored.agentRoutes[key].threadId).toBe('channel');
    expect(restored.agentRoutes[key].standingWorkRevision).toBeGreaterThan(enabled.agentRoutes[key].standingWorkRevision);
    expect(f.creates).toBe(0);
  } finally { await f.close(); }
});
test('individual mutation rejects stale/foreign/body identity and unregistered Cat before owner effects', async () => {
  const f = await setup(); try {
    const invoke = ownerAction(f.active.actions['collective.control.http']!, 'local-owner', f.current), before = await f.route(), body = individualInput(before.revision);
    expect(await ownerAction(f.active.actions['collective.control.http']!, 'foreign-owner', f.current)(individualRequest(f.connection.connectionId, body, 'foreign-owner'))).toMatchObject({ status: 403, body: { code: 'CONNECTOR_OWNER_MISMATCH' } });
    expect(await invoke(individualRequest(f.connection.connectionId, { ...body, expectedRevision: before.revision + 1 }))).toMatchObject({ status: 409, body: { code: 'PARTICIPATION_REVISION_CONFLICT' } });
    expect(await invoke(individualRequest(f.connection.connectionId, { ...body, userId: 'local-owner' }))).toMatchObject({ status: 400, body: { code: 'INVALID_PARTICIPATION_REQUEST' } });
    f.roster.splice(0);
    expect(await invoke(individualRequest(f.connection.connectionId, body))).toMatchObject({ status: 422, body: { code: 'PARTICIPATION_UNSUPPORTED' } });
    expect(await f.route()).toEqual(before); expect(f.creates).toBe(0);
  } finally { await f.close(); }
});
test('individual mutation preserves owned-thread refusal, per-connection serialization and currentness', async () => {
  const f = await setup(); try {
    const invoke = ownerAction(f.active.actions['collective.control.http']!, 'local-owner', f.current), before = await f.route(), body = individualInput(before.revision);
    f.threads.get('channel')!.createdBy = 'foreign-owner';
    expect(await invoke(individualRequest(f.connection.connectionId, body))).toMatchObject({ status: 409, body: { code: 'ROUTE_THREAD_UNAVAILABLE' } });
    expect(await f.route()).toEqual(before);
    f.threads.get('channel')!.createdBy = 'local-owner';
    const results = await Promise.all([invoke(individualRequest(f.connection.connectionId, body)), invoke(individualRequest(f.connection.connectionId, body))]);
    expect(results.map(r => (r as { status: number }).status).sort()).toEqual([200, 409]);
    const after = await f.route(); expect(after.revision).toBe(before.revision + 1); expect(f.creates).toBe(0);
    f.expire(); await expect(invoke(individualRequest(f.connection.connectionId, individualInput(after.revision)))).rejects.toThrow(/expired/);
    expect(await f.route()).toEqual(after);
  } finally { await f.close(); }
});

test('individual mutation creates one owned thread for a new Cat binding and reuses it on repeated edits', async () => {
  const f = await setup(true); try {
    const invoke = ownerAction(f.active.actions['collective.control.http']!, 'local-owner', f.current), before = await f.route();
    expect(await invoke(individualRequest(f.connection.connectionId, individualInput(before.revision)))).toMatchObject({ status: 200 });
    const after = await f.route(), key = `${f.owner.human.humanId}:codex-sol`;
    expect(after.agentRoutes[key].threadId).toBe('owner-thread-1');
    expect(f.threads.get('owner-thread-1')).toEqual({ id: 'owner-thread-1', createdBy: 'local-owner', participants: ['codex-sol'] });
    expect(await invoke(individualRequest(f.connection.connectionId, individualInput(after.revision)))).toMatchObject({ status: 200 });
    expect((await f.route()).agentRoutes[key].threadId).toBe('owner-thread-1'); expect(f.creates).toBe(1);
  } finally { await f.close(); }
});
test('revoked connection cannot change individual participation or standing-work authority', async () => {
  const f = await setup(); try {
    const invoke = ownerAction(f.active.actions['collective.control.http']!, 'local-owner', f.current);
    expect(await invoke({ request: { method: 'POST', path: `connections/${f.connection.connectionId}/revoke`,
      headers: { origin: 'http://localhost:5172' }, principal: { kind: 'owner', id: 'local-owner' } } })).toMatchObject({ status: 200 });
    const before = await f.route();
    expect(await invoke(individualRequest(f.connection.connectionId, individualInput(before.revision)))).toMatchObject({ status: 409, body: { code: 'PARTICIPATION_REVOKED' } });
    expect(await f.route()).toEqual(before); expect(f.creates).toBe(0);
  } finally { await f.close(); }
});


const rawRouteRequest = (id: string, body: unknown, owner = 'local-owner') => ({ request: {
  method: 'PUT', path: `connections/${id}/route`, body, headers: { origin: 'http://localhost:5172' },
  principal: { kind: 'owner', id: owner },
} });
test('actual owner pairing cannot create a connection after its authenticated owner request expires during roster read', async () => {
  let revokeOnRead = false;
  let f: Awaited<ReturnType<typeof setup>>;
  const selected = entrypoint;
  f = await setup(false, { async list() {
    if (revokeOnRead) f.expire();
    return [{ catId: 'codex-sol', displayName: 'Sol', defaultModel: 'fixture', available: true }];
  }, async get(){return null;} }, selected);
  const invoke = (path: string, method: string, body?: unknown) => ownerAction(f.active.actions['collective.control.http']!, 'local-owner', f.current)({ request: {
    path, method, body, headers: { origin: 'http://localhost:5172' }, principal: { kind: 'owner', id: 'local-owner' },
  } });
  const connections = async () => Object.keys(JSON.parse(await readFile(join(f.root, 'connector/collective-connector.json'), 'utf8')).connections).sort();
  try {
    const roster = await invoke('entry-roster', 'GET') as { body: { fingerprint: string } };
    const collective = await f.store.createCollective({ sessionToken: f.owner.sessionToken, name: 'Second pair currentness' });
    const intent = await f.store.createPairingIntent({ sessionToken: f.owner.sessionToken, collectiveId: collective.collectiveId,
      hostOrigin: 'http://localhost:5172', nonce: 'owner-currentness-pairing-1234' });
    const before = await connections();
    revokeOnRead = true;
    await expect(invoke('pair', 'POST', { serviceUrl: f.connection.serviceUrl, endpointLabel: 'Second connection',
      intent, rosterFingerprint: roster.body.fingerprint, excludedCatIds: [] })).rejects.toThrow(/expired/);
    expect(await connections()).toEqual(before);
  } finally { await f.close(); }
});
test('raw owner route PUT is retained in the existing authenticated webhook declaration', () => {
  const row = manifest.contributions.find((c: { path?: string }) => c.path === 'connections/:connectionId/route');
  expect(row).toMatchObject({ type: 'webhook', methods: ['GET', 'PUT'], action: { method: 'collective.control.http' } });
});
test('raw owner route PUT uses the actual module and original Connector route CAS before publication', async () => {
  const f = await setup(); try {
    const invoke = ownerAction(f.active.actions['collective.control.http']!, 'local-owner', f.current), before = await f.route();
    const body = { defaultIngressThreadId: 'channel', humanNotificationThreadId: 'channel', expectedRevision: before.revision,
      agentRoutes: { [`${f.owner.human.humanId}:codex-sol`]: { catId: 'codex-sol', threadId: 'channel' } } };
    expect(await invoke(rawRouteRequest(f.connection.connectionId, { ...body, localOwnerUserId: 'forged' }))).toMatchObject({ status: 400 });
    expect(await f.route()).toEqual(before);
    expect(await invoke(rawRouteRequest(f.connection.connectionId, body))).toMatchObject({ status: 200 });
    const after = await f.route(); expect(after.revision).toBe(before.revision + 1);
    expect(after.localOwnerUserId).toBe('local-owner'); expect(after.agentRoutes).toEqual(body.agentRoutes);
    expect(f.creates).toBe(0);
  } finally { await f.close(); }
});


test('raw owner route consumes ordinary member availability and refuses quota loss', async () => {
  const f = await setup(); try {
    const invoke = ownerAction(f.active.actions['collective.control.http']!, 'local-owner', f.current), before = await f.route();
    const body = { defaultIngressThreadId: 'channel', humanNotificationThreadId: 'channel', expectedRevision: before.revision,
      agentRoutes: { [`${f.owner.human.humanId}:codex-sol`]: { catId: 'codex-sol', threadId: 'channel' } } };
    expect(await invoke(rawRouteRequest(f.connection.connectionId, body))).toMatchObject({ status: 200 });
    const after = await f.route(); f.quota.set('codex-sol', false);
    expect(await invoke(rawRouteRequest(f.connection.connectionId, { ...body, expectedRevision: after.revision }))).toMatchObject({ status: 422, body: { code: 'ROUTE_CAT_UNAVAILABLE' } });
    expect(await f.route()).toEqual(after);
  } finally { await f.close(); }
});
test('raw owner route retains foreign owner/body/thread refusals, scoped revision requirement and shared CAS serialization', async () => {
  const f = await setup(); try {
    const invoke = ownerAction(f.active.actions['collective.control.http']!, 'local-owner', f.current), before = await f.route();
    const body = { defaultIngressThreadId: 'channel', humanNotificationThreadId: 'channel', expectedRevision: before.revision,
      agentRoutes: { [`${f.owner.human.humanId}:codex-sol`]: { catId: 'codex-sol', threadId: 'channel' } } };
    expect(await ownerAction(f.active.actions['collective.control.http']!, 'foreign-owner', f.current)(rawRouteRequest(f.connection.connectionId, body, 'foreign-owner'))).toMatchObject({ status: 403 });
    const { expectedRevision: _revision, ...noRevision } = body;
    expect(await invoke(rawRouteRequest(f.connection.connectionId, noRevision))).toMatchObject({ status: 400, body: { code: 'PARTICIPATION_REVISION_REQUIRED' } });
    f.threads.get('channel')!.createdBy = 'foreign';
    expect(await invoke(rawRouteRequest(f.connection.connectionId, body))).toMatchObject({ status: 422, body: { code: 'ROUTE_THREAD_UNAVAILABLE' } });
    f.threads.get('channel')!.createdBy = 'local-owner';
    expect(await f.route()).toEqual(before);
    const results = await Promise.all([invoke(rawRouteRequest(f.connection.connectionId, body)), invoke(rawRouteRequest(f.connection.connectionId, body))]);
    expect(results.map(r => (r as { status: number }).status).sort()).toEqual([200, 409]);
    const after = await f.route(); expect(after.revision).toBe(before.revision + 1);
    f.expire(); await expect(invoke(rawRouteRequest(f.connection.connectionId, { ...body, expectedRevision: after.revision }))).rejects.toThrow(/expired/);
    expect(await f.route()).toEqual(after); expect(f.creates).toBe(0);
  } finally { await f.close(); }
});

test('raw scoped route keeps original profile/standing checks and publishes the accepted configuration', async () => {
  const f = await setup(); try {
    const invoke = ownerAction(f.active.actions['collective.control.http']!, 'local-owner', f.current), before = await f.route();
    const key = `${f.owner.human.humanId}:codex-sol`;
    const row = { catId: 'codex-sol', threadId: 'channel', participation: { displayName: 'Sol（fixture）', channelIds: ['general'] },
      standingWork: { channelIds: ['general'], requestingHumanIds: ['requesting-human'], expiresAt: null } };
    const body = { defaultIngressThreadId: 'channel', humanNotificationThreadId: 'channel', expectedRevision: before.revision,
      agentRoutes: { [key]: row } };
    expect(await invoke(rawRouteRequest(f.connection.connectionId, { ...body,
      agentRoutes: { [key]: { ...row, participation: { ...row.participation, displayName: 'forged' } } } })))
      .toMatchObject({ status: 422, body: { code: 'PARTICIPATION_UNSUPPORTED' } });
    expect(await invoke(rawRouteRequest(f.connection.connectionId, { ...body,
      agentRoutes: { [key]: { ...row, standingWork: { ...row.standingWork, channelIds: ['private'] } } } })))
      .toMatchObject({ status: 422, body: { code: 'OWNER_ADMISSION_SCOPE_MISMATCH' } });
    expect(await f.route()).toEqual(before);
    expect(await invoke(rawRouteRequest(f.connection.connectionId, body))).toMatchObject({ status: 200 });
    const after = await f.route();
    expect(after.agentRoutes[key]).toMatchObject(row);
    expect(after.agentRoutes[key].standingWorkRevision).toBeGreaterThan(0);
    expect(f.store.listParticipants(f.owner.sessionToken, f.connection.collectiveId))
      .toContainEqual(expect.objectContaining({ catId: 'codex-sol', displayName: 'Sol（fixture）', participationRevision: after.revision }));
    expect(f.creates).toBe(0);
  } finally { await f.close(); }
});

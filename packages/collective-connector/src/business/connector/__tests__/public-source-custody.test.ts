import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { setHostRouteInputSchema } from '../host-route-state.js';
import { fixture } from './communication-work-custody.fixture.js';

const native = { contributionId: 'collective-native', methods: ['collective.reply.submit', 'collective.context.current'] };
async function setup() {
  const f = await fixture();
  await f.connector.sync(f.connection.connectionId);
  await f.connector.beginInboxRouting(f.connection.connectionId, f.source.eventId, 1);
  const input = { connectionId: f.connection.connectionId, eventId: f.source.eventId,
    pluginInstanceId: 'installed-instance', ownerUserId: 'local-owner', threadId: 'channel',
    messageRef: 'message:host-source' as const, native };
  // These operations belong to the existing Connector inbox, not a new launch ledger.
  const connector = f.connector;
  return { ...f, input, bind: (overrides: object = {}) => connector.recordPublicSource({ ...input, ...overrides }),
    read: async (ref: string = input.messageRef) => connector.readCurrentPublicSource(ref) };
}

it('stores a detached exact source binding before admission and reopens the same private inbox record', async () => {
  const f = await setup(); try {
    const binding = await f.bind();
    expect(binding).toMatchObject({ source: f.source, messageRef: f.input.messageRef,
      pluginInstanceId: 'installed-instance', threadId: 'channel', ownerUserId: 'local-owner', targetCatId: 'codex-sol' });
    expect(binding.native.methods).toEqual([...native.methods].sort());
    expect(binding.authority.ref).toMatch(/^collective-public:[a-f0-9]{64}$/);
    expect(binding.authority.revision).toMatch(/^[a-f0-9]{64}$/);
    binding.native.methods.push('forged');
    expect((await f.read()).native.methods).toEqual([...native.methods].sort());
    const reopened = await f.open();
    expect(await reopened.readCurrentPublicSource(f.input.messageRef)).toEqual(await f.read());
    const item = (await reopened.listInbox(f.connection.connectionId)).find((item) => item.event.eventId === f.source.eventId);
    expect(item!.publicSource).toEqual(await f.read());
  } finally { await f.close(); }
});

it('replays an exact binding but refuses message, instance, thread, owner or native rebind without changing bytes', async () => {
  const f = await setup(); try {
    const binding = await f.bind();
    expect(await f.bind()).toEqual(binding);
    const path = join(f.root, 'connector', 'collective-connector.json'), before = await readFile(path);
    for (const input of [{ messageRef: 'message:other' }, { pluginInstanceId: 'foreign' }, { threadId: 'foreign' },
      { ownerUserId: 'foreign' }, { native: { ...native, methods: ['collective.context.current'] } }]) {
      await expect(f.bind(input)).rejects.toBeInstanceOf(Error);
      expect(await readFile(path)).toEqual(before);
    }
  } finally { await f.close(); }
});

it('keeps the source across a routing retry but refuses a removed or re-added participation scope', async () => {
  const f = await setup(); try {
    const binding = await f.bind();
    await f.connector.failInboxRouting(f.connection.connectionId, f.source.eventId, 1, { code: 'ROUTE_QUEUE_FULL', message: 'Full' });
    await f.connector.beginInboxRouting(f.connection.connectionId, f.source.eventId, 1);
    expect(await f.read()).toEqual(binding);
    const route = await f.connector.getHostRoute(f.connection.connectionId);
    if (!route) throw new Error('Expected route');
    await f.connector.setHostRoute(f.connection.connectionId, setHostRouteInputSchema.strip().parse({ ...route, agentRoutes: {} }), 1);
    await expect(f.read()).rejects.toMatchObject({ code: 'PARTICIPATION_REVOKED' });
    await f.connector.setHostRoute(f.connection.connectionId, setHostRouteInputSchema.strip().parse(route), 2);
    await expect(f.read()).rejects.toMatchObject({ code: 'PARTICIPATION_REVOKED' });
  } finally { await f.close(); }
});

it('preserves exact source permission across unrelated roster changes but rejects destination drift', async () => {
  const f = await setup(); try {
    const binding = await f.bind(), route = await f.connector.getHostRoute(f.connection.connectionId);
    if (!route) throw new Error('Expected route');
    await f.connector.setHostRoute(f.connection.connectionId, setHostRouteInputSchema.strip().parse({ ...route, agentRoutes: { ...route.agentRoutes,
      [`${f.owner.human.humanId}:another-cat`]: { catId: 'another-cat', threadId: 'other-channel',
        participation: { displayName: 'Other', channelIds: ['general'] } } } }), 1);
    expect(await f.read()).toEqual(binding);
    const current = await f.connector.getHostRoute(f.connection.connectionId);
    if (!current) throw new Error('Expected route');
    await f.connector.setHostRoute(f.connection.connectionId, setHostRouteInputSchema.strip().parse({ ...current, agentRoutes: {
      ...current.agentRoutes, [`${f.owner.human.humanId}:codex-sol`]: {
        ...current.agentRoutes[`${f.owner.human.humanId}:codex-sol`], threadId: 'moved-channel' } } }), 2);
    await expect(f.read()).rejects.toMatchObject({ code: 'PUBLIC_SOURCE_CHANGED' });
  } finally { await f.close(); }
});

it('rejects unknown messages, missing routing attempt, duplicate/reserved methods and revoked endpoint authority', async () => {
  const f = await setup(); try {
    await expect(f.read('message:unknown')).rejects.toMatchObject({ code: 'PUBLIC_SOURCE_UNAVAILABLE' });
    for (const methods of [[], ['x', 'x'], ['host.public-invocation.assert-current']]) {
      await expect(f.bind({ native: { ...native, methods } })).rejects.toBeInstanceOf(Error);
    }
    await f.bind(); await f.connector.revoke(f.connection.connectionId);
    await expect(f.read()).rejects.toMatchObject({ code: 'PARTICIPATION_REVOKED' });
  } finally { await f.close(); }
});


it('does not bind an unstarted routing attempt or a Work entrust event through the ordinary public source consumer', async () => {
  const f = await setup(); try {
    const post = (id: string, workRequest?: 'entrust') => f.store.postHumanMessage(f.owner.sessionToken, {
      serviceInstanceId: f.connection.serviceInstanceId, collectiveId: f.connection.collectiveId,
      clientEventId: id, location: f.source.location,
      recipient: { kind: 'agent', humanId: f.owner.human.humanId, connectionId: f.connection.connectionId,
        agentId: f.source.catId, participationRevision: f.source.participationRevision },
      body: 'New event', ...(workRequest ? { workRequest } : {}) });
    const ordinary = await post('unstarted'); const work = await post('private-entrust', 'entrust');
    await f.connector.sync(f.connection.connectionId);
    await expect(f.bind({ eventId: ordinary.eventId })).rejects.toMatchObject({ code: 'PUBLIC_SOURCE_UNAVAILABLE' });
    await f.connector.beginInboxRouting(f.connection.connectionId, work.eventId, 1);
    await expect(f.bind({ eventId: work.eventId })).rejects.toMatchObject({ code: 'PUBLIC_SOURCE_UNAVAILABLE' });
    expect((await f.connector.listInbox(f.connection.connectionId)).every(item => item.publicSource === undefined)).toBe(true);
  } finally { await f.close(); }
});

it('serializes concurrent exact bindings through the existing persistence tail and rejects competing message claims', async () => {
  const f = await setup(); try {
    const winners = await Promise.all(Array.from({ length: 8 }, () => f.bind()));
    expect(winners.every(item => JSON.stringify(item) === JSON.stringify(winners[0]))).toBe(true);
    await expect(f.bind({ messageRef: 'message:competing' })).rejects.toMatchObject({ code: 'PUBLIC_SOURCE_CHANGED' });
    expect(await f.read()).toEqual(winners[0]);
  } finally { await f.close(); }
});

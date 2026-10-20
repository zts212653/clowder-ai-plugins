import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isCollectiveLocalEcho } from '../public-source-custody.js';
import { setHostRouteInputSchema } from '../host-route-state.js';
import { publicSourceFixture as setup } from './public-source-caller.fixture.js';

it('records the public send receipt before a same-connection route writer can retarget the source', async () => {
  const f = await setup(); let writer: Promise<unknown> | undefined; let settledDuringSend = false;
  try {
    f.beforeSendReturns(async () => {
      const route = (await f.connector.getHostRoute(f.connection.connectionId))!;
      writer = f.connector.setHostRoute(f.connection.connectionId, setHostRouteInputSchema.strip().parse({...route,
        defaultIngressThreadId: 'replacement',
        agentRoutes: Object.fromEntries(Object.entries(route.agentRoutes).map(([key, value]) => [key, {...value, threadId: 'replacement'}])),
      }), route.revision);
      settledDuringSend = await Promise.race([writer.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 20))]);
      // A real early native callback must still read/bind without re-entering the route writer tail.
      await f.sourceCaller.resolveNative(f.action, 'collective.context.current');
    });
    const receipt = await f.admit();
    await writer;
    expect(settledDuringSend).toBe(false);
    const item = (await f.connector.listInbox(f.connection.connectionId)).find(item => item.event.eventId === f.source.eventId)!;
    expect(item.disposition).toBe('routed');
    expect(item.routeReceipt).toMatchObject(receipt);
    expect(item.routeReceipt).toMatchObject({threadId: 'channel', messageId: 'host-source'});
    expect((await f.connector.getHostRoute(f.connection.connectionId))!.defaultIngressThreadId).toBe('replacement');
    expect(f.calls.filter((call: any) => call[0] === 'send')).toHaveLength(1);
  } finally {await writer;await f.close();}
});

it('retains the actual public send receipt when endpoint revocation refuses executable source binding', async () => {
  const f = await setup();
  try {
    f.beforeSendReturns(async () => {await f.connector.revoke(f.connection.connectionId);});
    await expect(f.admit()).rejects.toBeInstanceOf(Error);
    const item = (await f.connector.listInbox(f.connection.connectionId)).find(item => item.event.eventId === f.source.eventId)!;
    expect(item).toMatchObject({disposition: 'routed', routeReceipt: {messageId: 'host-source', threadId: 'channel'}});
    expect(() => f.connector.readCurrentPublicSource('message:host-source')).toThrow();
  } finally {await f.close();}
});

it('settles a lost public receipt after retargeting without granting the historical destination', async () => {
  const f = await setup();
  try {
    f.loseSend();await expect(f.admit()).rejects.toThrow('Wake send response lost');
    const route = (await f.connector.getHostRoute(f.connection.connectionId))!;
    await f.connector.setHostRoute(f.connection.connectionId, setHostRouteInputSchema.strip().parse({...route,
      defaultIngressThreadId: 'replacement',
      agentRoutes: Object.fromEntries(Object.entries(route.agentRoutes).map(([key, value]) => [key, {...value, threadId: 'replacement'}])),
    }), route.revision);
    f.recoverSend();await expect(f.admit()).rejects.toMatchObject({code: 'PUBLIC_SOURCE_CHANGED'});
    const item = (await f.connector.listInbox(f.connection.connectionId)).find(item => item.event.eventId === f.source.eventId)!;
    expect(item).toMatchObject({disposition: 'routed', routeReceipt: {messageId: 'host-source', threadId: 'channel'}});
    expect(() => f.connector.readCurrentPublicSource('message:host-source')).toThrow();
    const sends = f.calls.filter((call: any) => call[0] === 'send') as any[];
    expect(sends.map(call => call[1])).toEqual(['channel', 'replacement']);
    expect(sends[0][2].idempotencyKey).toBe(sends[1][2].idempotencyKey);
  } finally {await f.close();}
});

it('sends with named wake and rechecks the original Service through standard message data', async () => {
  const f = await setup(); try {
    const receipt = await f.admit();
    expect(receipt).toEqual({ messageId: 'host-source', threadId: 'channel' });
    if ('kind' in receipt) throw new Error('Expected message receipt for non-echo source');
    const messageRef = `message:${receipt.messageId}` as const;
    expect(f.calls.map((call: any) => call[0])).toEqual(['thread', 'send']);
    const draft = (f.calls[1] as any)[2]; expect(draft.wake).toEqual({ catId: f.source.catId });
    expect(draft.meta.participation).toEqual(f.source);
    expect(draft.payload.provenance).toEqual({ origin: { kind: 'plugin', instanceId: 'installed-instance' }, epistemicStatus: 'observation' });
    expect(f.connector.readCurrentPublicSource(messageRef)).not.toHaveProperty('authority');
    const resolved = await f.sourceCaller.resolveNative(f.action, 'collective.context.current');
    expect(resolved.source).toEqual(f.source); expect(resolved.auth.invocationId).toEqual(f.action.invocationId);
  } finally { await f.close(); }
});

it('lost Host wake receipt retries the same idempotent send when no native mapping has arrived yet', async () => {
  const f = await setup(); try {
    f.loseSend(); await expect(f.admit()).rejects.toThrow('Wake send response lost');
    expect(() => f.connector.readCurrentPublicSource('message:host-source')).toThrow();
    f.recoverSend(); await f.admit();
    expect(f.connector.readCurrentPublicSource('message:host-source').source).toEqual(f.source);
    const sends = f.calls.filter((call: any) => call[0] === 'send') as any[];
    expect(sends).toHaveLength(2); expect(sends[0][2]).toEqual(sends[1][2]);
    expect(f.calls.filter((call: any) => call[0] === 'enqueue')).toHaveLength(0);
  } finally { await f.close(); }
});

it('ordinary source handling checks declared business method and current Service without a public verifier', async () => {
  const f=await setup();try {
    await f.admit();expect(f.sourceCaller).not.toHaveProperty('publicInvocationVerifier');
    await expect(f.sourceCaller.resolveNative(f.action,'unknown')).rejects.toBeInstanceOf(Error);
    await f.connector.revoke(f.connection.connectionId);
    await expect(f.sourceCaller.resolveNative(f.action,'collective.context.current')).rejects.toBeInstanceOf(Error);
  } finally {await f.close();}
});

it('native body identity cannot replace authenticated context, exact origin/content or Service currentness', async () => {
  const f = await setup(); try {
    await f.admit();
    for (const change of [{ catId: 'foreign' }, { threadId: 'foreign' }, { userId: 'foreign' }])
      await expect(f.sourceCaller.resolveNative({ ...f.action, ...change }, 'collective.context.current')).rejects.toMatchObject({ code: 'PUBLIC_SOURCE_CHANGED' });
    f.updateFact({ extra: { pluginMessage: { instanceId: 'foreign' } } });
    await expect(f.sourceCaller.resolveNative(f.action, 'collective.context.current')).resolves.toHaveProperty('source');
    f.updateFact({ extra: { pluginMessage: { instanceId: 'installed-instance' } }, content: 'forged' });
    await expect(f.sourceCaller.resolveNative(f.action, 'collective.context.current')).rejects.toMatchObject({ code: 'PUBLIC_SOURCE_CHANGED' });
    f.updateFact({ content: (await f.connector.listInbox(f.connection.connectionId)).find(item => item.event.eventId === f.source.eventId)!.event.body });
    f.expire(); await expect(f.sourceCaller.resolveNative(f.action, 'collective.context.current')).rejects.toThrow('Caller expired');
  } finally { await f.close(); }
});


it('does not send or enqueue after the Service revokes permission while the owner thread check is in flight', async () => {
  const f = await setup(); try {
    f.beforeThread(async () => { await f.store.revokeConnection({ sessionToken: f.serviceOwner.sessionToken,
      collectiveId: f.connection.collectiveId, connectionId: f.connection.connectionId }); });
    await expect(f.admit()).rejects.toBeInstanceOf(Error);
    expect(f.calls.filter((call: any) => call[0] === 'send' || call[0] === 'enqueue')).toHaveLength(0);
  } finally { await f.close(); }
});

it('a resolved native caller rechecks real Service permission before a later reply; currentness is not cached', async () => {
  const f = await setup(); try {
    await f.admit(); const resolved = await f.sourceCaller.resolveNative(f.action, 'collective.reply.submit');
    await f.store.revokeConnection({ sessionToken: f.serviceOwner.sessionToken, collectiveId: f.connection.collectiveId,
      connectionId: f.connection.connectionId });
    await expect(resolved.revalidate()).rejects.toBeInstanceOf(Error);
    // Local mapping still exists. The refusal is the Service truth, not merely local map deletion.
    expect(f.connector.readCurrentPublicSource('message:host-source')).toEqual(resolved.binding);
  } finally { await f.close(); }
});


it('a late wake receipt after owner stop is refused without undoing the early native source mapping', async () => {
  const f = await setup(); try {
    f.beforeSendReturns(async () => { await f.sourceCaller.resolveNative(f.action, 'collective.context.current'); f.expire(); });
    await expect(f.admit()).rejects.toThrow('Caller expired');
    expect(f.connector.readCurrentPublicSource('message:host-source').source).toEqual(f.source);
    expect(f.calls.filter((call: any) => call[0] === 'send')).toHaveLength(1);
  } finally { await f.close(); }
});

it('returns local_echo for a real same-connection Agent publication before routing, Host send or Queue admission', async () => {
  const f = await setup(); try {
    const state = JSON.parse(await readFile(join(f.root, 'connector', 'collective-connector.json'), 'utf8'));
    const event = await f.store.postAgentMessage(state.connections[f.connection.connectionId].endpointCredential, {
      serviceInstanceId: f.connection.serviceInstanceId, collectiveId: f.connection.collectiveId,
      connectionId: f.connection.connectionId, clientEventId: 'same-connection-echo', agent: f.agent,
      location: f.source.location, recipient: { kind: 'agent', humanId: f.serviceOwner.human.humanId,
        connectionId: f.connection.connectionId, agentId: f.source.catId, participationRevision: 1 },
      replyToEventId: f.source.eventId, body: 'My own public Agent message',
    });
    expect(event.actor.kind).toBe('agent');
    if (event.actor.kind !== 'agent') throw new Error('Expected Agent publication');
    expect(event.actor.provenance.connectionId).toBe(f.connection.connectionId);
    await f.connector.sync(f.connection.connectionId);
    const before = (await f.connector.listInbox(f.connection.connectionId)).find(item => item.event.eventId === event.eventId);
    expect(await f.sourceCaller.admitAgentEvent(f.connection.connectionId, event.eventId, f.owner)).toEqual({ kind: 'local_echo' });
    expect(f.calls).toEqual([]);
    expect((await f.connector.listInbox(f.connection.connectionId)).find(item => item.event.eventId === event.eventId)).toEqual(before);
    // Even a caller that bypasses the bridge cannot turn this retained echo into a verifier source.
    await f.connector.beginInboxRouting(f.connection.connectionId, event.eventId, 1);
    await expect(f.connector.recordPublicSource({ connectionId: f.connection.connectionId, eventId: event.eventId,
      pluginInstanceId: 'installed-instance', ownerUserId: 'local-owner', threadId: 'channel', messageRef: 'message:echo',
      native: { contributionId: 'collective-native', methods: ['collective.context.current'] } })).rejects.toMatchObject({ code: 'PUBLIC_SOURCE_LOCAL_ECHO' });
    expect((await f.connector.listInbox(f.connection.connectionId)).find(item => item.event.eventId === event.eventId)?.publicSource).toBeUndefined();
  } finally { await f.close(); }
});

it('does not classify a real same-connection Work acceptance notice as local echo or admit it through the ordinary consumer', async () => {
  const f = await setup(); try {
    await f.connector.adoptWorkPolicy(f.connection.connectionId, 'local-owner', f.policy.revision);
    await f.connector.acceptWork(f.source, f.agent, f.input);
    await f.connector.sync(f.connection.connectionId);
    const item = (await f.connector.listInbox(f.connection.connectionId)).find(item => item.event.workAcceptanceNotice);
    expect(item).toBeDefined();
    if (!item) throw new Error('Expected real Work acceptance notice');
    expect(item.event.actor.kind).toBe('agent');
    expect(isCollectiveLocalEcho(item.event, f.connection.connectionId)).toBe(false);
    await expect(f.sourceCaller.admitAgentEvent(f.connection.connectionId, item.event.eventId, f.owner))
      .rejects.toMatchObject({ code: 'PUBLIC_SOURCE_UNAVAILABLE' });
    expect(f.calls).toEqual([]);
    expect((await f.connector.listInbox(f.connection.connectionId)).find(candidate => candidate.event.eventId === item.event.eventId)?.publicSource).toBeUndefined();
  } finally { await f.close(); }
});

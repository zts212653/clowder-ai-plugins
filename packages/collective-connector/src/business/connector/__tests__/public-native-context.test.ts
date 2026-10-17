import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { PluginActionHandler } from '@clowder-ai/plugin-sdk';
import { openCollectiveContextReferences } from '../../../collective-context-refs.js';
import { publicSourceFixture } from './public-source-caller.fixture.js';

const methods = ['collective.context.current', 'collective.context.read', 'collective.participation.set-interest', 'collective.reply.submit'];
async function setup() {
  const module = await import('../../../collective-public-native-context.js');
  const f = await publicSourceFixture({ methods, invocationId: 'fixture-running-turn' });
  try {
    const refs = await openCollectiveContextReferences(join(f.root, 'native-refs'), () => {});
    const actions = module.createCollectivePublicNativeActions({ connector: f.connector, references: refs, sourceCaller: f.sourceCaller });
    await f.admit();
    const invoke = (method: string, body: unknown) => Promise.resolve((actions as Record<string, PluginActionHandler>)[method]!(body, f.action));
    const current = () => invoke('collective.context.current', {}) as Promise<any>;
    return { ...f, actions, invoke, current };
  } catch (error) { await f.close(); throw error; }
}

it('reads authenticated ordinary context and bounded Work candidates with the original durable reply slot', async () => {
  const f = await setup(); try {
    const current = await f.current();
    expect(current).toMatchObject({ kind: 'collective', authority: 'public_participation', participant: 'Sol', reply: { status: 'prepared' } });
    expect(current.workDecision).toEqual(await f.connector.currentWorkDecision(f.source));
    expect(current.workSourceContext).toMatchObject({ sourceEventId: f.source.eventId, matters: [] });
    expect(current.contextRef).toMatch(/^[\w-]{43}$/);
    const context = await f.invoke('collective.context.read', { contextRef: current.contextRef });
    expect(context).toEqual(await f.connector.readParticipationContext(f.source, 0, 30));
    const again = await f.current(); expect(again.replyOperationRef).toBe(current.replyOperationRef);
    const state = JSON.parse(await readFile(join(f.root, 'connector', 'collective-connector.json'), 'utf8'));
    expect(state.connections[f.connection.connectionId].outbox).toHaveLength(1);
  } finally { await f.close(); }
});

it('submits the original named business reply and replays the same receipt without a new outbox item', async () => {
  const f = await setup(); try {
    const c = await f.current();
    const body = { returnRef: c.returnRef, replyOperationRef: c.replyOperationRef, body: '  Original ordinary reply  ' };
    const replied: any = await f.invoke('collective.reply.submit', body);
    expect(replied.reply).toMatchObject({ status: 'accepted', body: 'Original ordinary reply', author: f.agent });
    expect((await f.invoke('collective.reply.submit', body) as any).reply.eventId).toBe(replied.reply.eventId);
    await expect(f.invoke('collective.reply.submit', { ...body, body: 'Different answer' })).rejects.toMatchObject({ code: 'REPLY_PAYLOAD_CONFLICT' });
    const state = JSON.parse(await readFile(join(f.root, 'connector', 'collective-connector.json'), 'utf8'));
    expect(state.connections[f.connection.connectionId].outbox).toHaveLength(1);
  } finally { await f.close(); }
});

it('projects actual public Work candidates with refs bound to the package instance, invocation and source', async () => {
  const f = await setup(); try {
    await f.connector.proposeWork(f.source, 'candidate-proposal', f.agent, { title: 'A', intendedOutcome: 'Implement A' });
    const c = await f.current();
    const actual = await f.connector.readWorkSourceContext(f.source);
    expect(actual.matters).toHaveLength(1);
    expect(c.workSourceContext.matters[0]).toMatchObject(actual.matters[0]!);
    const workRef: string = c.workSourceContext.matters[0].workRef;
    const [payload, signature] = workRef.split('.');
    const refs = await openCollectiveContextReferences(join(f.root, 'native-refs'), () => {});
    expect(() => refs.verifyRef({ pluginInstanceId: 'installed-instance', invocationId: f.action.invocationId },
      signature!, `work:${payload}`, 'message:host-source')).not.toThrow();
    expect(() => refs.verifyRef({ pluginInstanceId: 'foreign-instance', invocationId: f.action.invocationId },
      signature!, `work:${payload}`, 'message:host-source')).toThrow();
  } finally { await f.close(); }
});

it('updates standing interest with the actual attention revision without changing source authority', async () => {
  const f = await setup(); try {
    const c = await f.current();
    expect(await f.invoke('collective.participation.set-interest', { contextRef: c.contextRef, state: 'listen' }))
      .toMatchObject({ catId: 'codex-sol', channelId: 'general', state: 'listen', attentionRevision: 1 });
    expect(await f.invoke('collective.participation.set-interest', { contextRef: c.contextRef, state: 'withdraw' }))
      .toMatchObject({ state: 'withdraw', attentionRevision: 2 });
  } finally { await f.close(); }
});

it('keeps original strict input bounds and rejects body identity, bad refs and absent native context before effects', async () => {
  const f = await setup(); try {
    const c = await f.current(); const prepare = vi.spyOn(f.connector, 'prepareReply'); const submit = vi.spyOn(f.connector, 'submitReply');
    for (const body of [{ userId: 'forged' }, { contextRef: c.contextRef }])
      await expect(f.invoke('collective.context.current', body)).rejects.toMatchObject({ code: 'INVALID_COLLECTIVE_REQUEST' });
    for (const change of [{ limit: 101 }, { afterSequence: -1 }, { catId: 'forged' }])
      await expect(f.invoke('collective.context.read', { contextRef: c.contextRef, ...change })).rejects.toMatchObject({ code: 'INVALID_COLLECTIVE_REQUEST' });
    await expect(f.invoke('collective.reply.submit', { returnRef: c.returnRef, replyOperationRef: c.replyOperationRef, body: 'a'.repeat(20001) }))
      .rejects.toMatchObject({ code: 'INVALID_COLLECTIVE_REQUEST' });
    await expect(f.invoke('collective.context.read', { contextRef: 'wrong' })).rejects.toMatchObject({ code: 'RETURN_REF_INVALID' });
    await expect(Promise.resolve(f.actions['collective.context.current']!({}))).rejects.toMatchObject({ code: 'NOT_COLLECTIVE_ORIGIN' });
    expect(prepare).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
    expect(f.actions).not.toHaveProperty('collective.progress.submit');
    expect(f.actions).not.toHaveProperty('collective.connector.send');
  } finally { vi.restoreAllMocks(); await f.close(); }
});

it('refuses a reconsideration carrier through the ordinary consumer instead of borrowing its policy or Queue receipt', async () => {
  const f = await setup(); try {
    f.updateFact({ source: { ...f.native.source.source, meta: { ...f.native.source.source.meta,
      reconsideration: { purposeKey: 'collective-reconsider:' + 'a'.repeat(64) } } } });
    const prepare = vi.spyOn(f.connector, 'prepareReply');
    await expect(f.current()).rejects.toMatchObject({ code: 'PUBLIC_SOURCE_UNAVAILABLE' });
    expect(prepare).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); await f.close(); }
});

it('rechecks actual Service permission before submit and refuses late results while retaining real queued effects', async () => {
  const f = await setup(); try {
    const c = await f.current(); const original = f.connector.submitReply.bind(f.connector);
    vi.spyOn(f.connector, 'submitReply').mockImplementation(async (...args) => { const result = await original(...args); f.expire(); return result; });
    const sync = vi.spyOn(f.connector, 'sync');
    await expect(f.invoke('collective.reply.submit', { returnRef: c.returnRef, replyOperationRef: c.replyOperationRef, body: 'Committed locally' }))
      .rejects.toThrow('Caller expired');
    expect(sync).not.toHaveBeenCalled();
    const state = JSON.parse(await readFile(join(f.root, 'connector', 'collective-connector.json'), 'utf8'));
    expect(state.connections[f.connection.connectionId].outbox[0]).toMatchObject({ status: 'queued', body: 'Committed locally' });
  } finally { vi.restoreAllMocks(); await f.close(); }
  const g = await setup(); try {
    const c = await g.current(); const submit = vi.spyOn(g.connector, 'submitReply');
    await g.store.revokeConnection({ sessionToken: g.serviceOwner.sessionToken, collectiveId: g.connection.collectiveId, connectionId: g.connection.connectionId });
    await expect(g.invoke('collective.reply.submit', { returnRef: c.returnRef, replyOperationRef: c.replyOperationRef, body: 'Revoked' })).rejects.toBeInstanceOf(Error);
    expect(submit).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); await g.close(); }
});

it('retains a committed reply across lost sync response and recovers the original business event', async () => {
  const f = await setup(); try {
    const c = await f.current(); const realSync = f.connector.sync.bind(f.connector);
    vi.spyOn(f.connector, 'sync').mockImplementationOnce(async id => { await realSync(id); throw new Error('Lost sync response'); });
    const body = { returnRef: c.returnRef, replyOperationRef: c.replyOperationRef, body: 'Durable answer' };
    await expect(f.invoke('collective.reply.submit', body)).rejects.toThrow('Lost sync response');
    const recovered = await f.current(); expect(recovered.reply).toMatchObject({ status: 'accepted', body: 'Durable answer' });
    expect((await f.invoke('collective.reply.submit', body) as any).reply.eventId).toBe(recovered.reply.eventId);
  } finally { vi.restoreAllMocks(); await f.close(); }
});

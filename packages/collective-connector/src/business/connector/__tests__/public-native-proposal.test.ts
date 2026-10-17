import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { openCollectiveContextReferences } from '../../../collective-context-refs.js';
import { createCollectivePublicNativeActions } from '../../../collective-public-native-context.js';
import { createCollectivePublicSourceCaller } from '../../../collective-public-source.js';
import { publicSourceFixture } from './public-source-caller.fixture.js';

async function setup() {
  const methods = ['collective.context.current', 'collective.work.propose'];
  const f = await publicSourceFixture({ methods, invocationId: 'fixture-running-turn' });
  try {
    const references = await openCollectiveContextReferences(join(f.root, 'proposal-refs'), () => {});
    const actions = createCollectivePublicNativeActions({ connector: f.connector, sourceCaller: f.sourceCaller, references });
    await f.admit();
    const invoke = (method: string, input: unknown, action = f.action) => Promise.resolve(actions[method]!(input, action)) as Promise<any>;
    const context = await invoke('collective.context.current', {});
    return { ...f, actions, invoke, context };
  } catch (error) { await f.close(); throw error; }
}

it('proposes one real Service Work from the authenticated public source with the original per-invocation operation', async () => {
  const f = await setup(); try {
    const spy = vi.spyOn(f.connector, 'proposeWork');
    const input = { contextRef: f.context.contextRef, title: '  Continue this matter  ', requestKind: ' implementation ', intendedOutcome: ' Reviewable result ' };
    const work = await f.invoke('collective.work.propose', input);
    expect(work).toMatchObject({ sourceEventId: f.source.eventId, status: 'proposed',
      proposedBy: { kind: 'agent', connectionId: f.connection.connectionId, catId: f.source.catId } });
    expect(spy).toHaveBeenCalledWith(f.source, 'work-proposal:fixture-running-turn', f.agent,
      { title: 'Continue this matter', requestKind: 'implementation', intendedOutcome: 'Reviewable result' });
    expect(await f.invoke('collective.work.propose', input)).toEqual(work);
    expect((await f.connector.readWorkSourceContext(f.source)).matters).toHaveLength(1);
  } finally { vi.restoreAllMocks(); await f.close(); }
});

it('rejects forged references, body authority, oversized fields and absent native identity before proposing', async () => {
  const f = await setup(); try {
    const spy = vi.spyOn(f.connector, 'proposeWork');
    await expect(f.invoke('collective.work.propose', { contextRef: 'wrong' })).rejects.toMatchObject({ code: 'RETURN_REF_INVALID' });
    for (const extra of [{ catId: 'other' }, { grantRef: 'owner' }, { workId: 'other' }, { title: 'x'.repeat(201) },
      { requestKind: 'x'.repeat(241) }, { intendedOutcome: 'x'.repeat(32001) }, { title: '   ' }])
      await expect(f.invoke('collective.work.propose', { contextRef: f.context.contextRef, ...extra })).rejects.toMatchObject({ code: 'INVALID_COLLECTIVE_REQUEST' });
    await expect(Promise.resolve(f.actions['collective.work.propose']!({ contextRef: f.context.contextRef }))).rejects.toMatchObject({ code: 'NOT_COLLECTIVE_ORIGIN' });
    await expect(f.invoke('collective.work.propose', { contextRef: f.context.contextRef }, { ...f.action, invocationId: 'other' })).rejects.toMatchObject({ code: 'PUBLIC_SOURCE_CHANGED' });
    expect(spy).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); await f.close(); }
});

it('refuses reconsideration and revoked participation through the original ordinary source boundary', async () => {
  const f = await setup(); try {
    const spy = vi.spyOn(f.connector, 'proposeWork');
    f.updateFact({ source: { ...f.native.source.source, meta: { ...f.native.source.source.meta, reconsideration: { purposeKey: 'original-purpose' } } } });
    await expect(f.invoke('collective.work.propose', { contextRef: f.context.contextRef })).rejects.toMatchObject({ code: 'PUBLIC_SOURCE_UNAVAILABLE' });
    expect(spy).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); await f.close(); }
  const g = await setup(); try {
    const spy = vi.spyOn(g.connector, 'proposeWork');
    await g.store.revokeConnection({ sessionToken: g.serviceOwner.sessionToken, collectiveId: g.connection.collectiveId, connectionId: g.connection.connectionId });
    await expect(g.invoke('collective.work.propose', { contextRef: g.context.contextRef })).rejects.toBeInstanceOf(Error);
    expect(spy).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); await g.close(); }
});

it('keeps the real proposal after lost response and after late lifecycle refusal without creating a second Work', async () => {
  const f = await setup(); try {
    const original = f.connector.proposeWork.bind(f.connector);
    vi.spyOn(f.connector, 'proposeWork').mockImplementationOnce(async (...args) => { await original(...args); throw new Error('Proposal response lost'); });
    const input = { contextRef: f.context.contextRef, title: 'Continue' };
    await expect(f.invoke('collective.work.propose', input)).rejects.toThrow('Proposal response lost');
    const recovered = await f.invoke('collective.work.propose', input);
    expect(recovered.status).toBe('proposed');
    expect((await f.connector.readWorkSourceContext(f.source)).matters).toHaveLength(1);
  } finally { vi.restoreAllMocks(); await f.close(); }
  const g = await setup(); try {
    const original = g.connector.proposeWork.bind(g.connector);
    vi.spyOn(g.connector, 'proposeWork').mockImplementationOnce(async (...args) => { const work = await original(...args); g.expire(); return work; });
    await expect(g.invoke('collective.work.propose', { contextRef: g.context.contextRef })).rejects.toThrow('Caller expired');
    expect((await g.connector.readWorkSourceContext(g.source)).matters).toHaveLength(1);
  } finally { vi.restoreAllMocks(); await g.close(); }
});


it('keeps original method permissions on a retained source after the native table grows without granting the new method', async () => {
  const legacy = ['collective.context.current', 'collective.context.read', 'collective.participation.set-interest', 'collective.reply.submit'];
  const f = await publicSourceFixture({ methods: legacy, invocationId: 'fixture-running-turn' });
  try {
    await f.admit();
    const before = f.connector.readCurrentPublicSource('message:host-source');
    const upgraded = createCollectivePublicSourceCaller({ connector: f.connector,
      native: { contributionId: 'collective-native', methods: [...legacy, 'collective.work.propose'] },
      nativeContext: { async current() { return structuredClone(f.native); } },
      ownerThreads: { async get() { throw new Error('No owner effect during native read'); },
        async create() { throw new Error('Unused'); }, async addParticipants() { throw new Error('Unused'); } },
      messaging: { async send() { throw new Error('No send during source replay'); }, async subscribe() { throw new Error('Unused'); }, async unsubscribe() { throw new Error('Unused'); } } });
    const current = await upgraded.resolveNative(f.action, 'collective.context.current');
    expect(current.binding).toEqual(before);
    await expect(upgraded.resolveNative(f.action, 'collective.work.propose')).rejects.toMatchObject({ code: 'PUBLIC_SOURCE_CHANGED' });
    expect(f.connector.readCurrentPublicSource('message:host-source')).toEqual(before);
    await expect(upgraded.publicInvocationVerifier({ source: { messageRef: 'message:host-source' }, authority: before.authority,
      targetCatId: before.targetCatId, native: before.native },
      { signal: new AbortController().signal, async assertCurrent() {} })).resolves.toEqual({ current: true });
  } finally { await f.close(); }
});


it('finishes the original routing after response loss across a native-method upgrade without widening its binding', async () => {
  const legacy = ['collective.context.current', 'collective.context.read', 'collective.participation.set-interest', 'collective.reply.submit'];
  const f = await publicSourceFixture({ methods: legacy, invocationId: 'fixture-running-turn' });
  try {
    f.beforeSendReturns(async () => { await f.sourceCaller.resolveNative(f.action, 'collective.context.current'); });
    f.loseSend(); await expect(f.admit()).rejects.toThrow('Wake send response lost');
    const binding = f.connector.readCurrentPublicSource('message:host-source');
    const originalDraft = (f.calls.find((call: any) => call[0] === 'send') as any)[2];
    let sends = 0;
    const upgraded = createCollectivePublicSourceCaller({ connector: f.connector,
      native: { contributionId: 'collective-native', methods: [...legacy, 'collective.work.propose'] },
      nativeContext: { async current() { return structuredClone(f.native); } },
      ownerThreads: { async get(id) { return { id, createdBy: f.owner.userId, participants: [f.source.catId] }; },
        async create() { throw new Error('Unused'); }, async addParticipants() { throw new Error('Unused'); } },
      messaging: { async send(threadId, draft) { sends++; expect(draft).toEqual(originalDraft);
        return { messageId: 'host-source', threadId, revision: 1, messageHandle: { kind: 'message' as const, token: 'retained-receipt' } }; },
        async subscribe() { throw new Error('Unused'); }, async unsubscribe() { throw new Error('Unused'); } } });
    const receipt = await upgraded.admitAgentEvent(f.connection.connectionId, f.source.eventId, f.owner);
    expect(receipt).toEqual({ messageId: 'host-source', threadId: 'channel' });
    expect((await f.connector.listInbox(f.connection.connectionId))[0]).toMatchObject({ disposition: 'routed' });
    expect(f.connector.readCurrentPublicSource('message:host-source')).toEqual(binding);
    expect(await upgraded.admitAgentEvent(f.connection.connectionId, f.source.eventId, f.owner)).toEqual(receipt);
    expect(sends).toBe(1);
    await expect(upgraded.resolveNative(f.action, 'collective.work.propose')).rejects.toMatchObject({ code: 'PUBLIC_SOURCE_CHANGED' });
  } finally { await f.close(); }
});

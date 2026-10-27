import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { openCollectiveContextReferences } from '../../../collective-context-refs.js';
import { createCollectivePublicNativeActions } from '../../../collective-public-native-context.js';
import { publicSourceFixture } from './public-source-caller.fixture.js';

async function setup(adopt = true) {
  const f = await publicSourceFixture({ invocationId: 'fixture-running-turn' });
  try {
    if (adopt) await f.connector.adoptWorkPolicy(f.connection.connectionId, f.owner.userId, f.policy.revision);
    const references = await openCollectiveContextReferences(join(f.root, 'work-action-refs'), () => {});
    const actions = createCollectivePublicNativeActions({ connector: f.connector, sourceCaller: f.sourceCaller, references });
    await f.admit();
    const invoke = (method: string, input: unknown, action = f.action) => Promise.resolve(actions[method]!(input, action)) as Promise<any>;
    const current = () => invoke('collective.context.current', {});
    const context = await current();
    const acceptance = { contextRef: context.contextRef, ...f.input };
    const accept = () => invoke('collective.work.accept', acceptance);
    const continuation = async () => {
      const next = await current();
      return { contextRef: next.contextRef, workRef: next.workSourceContext.matters[0].workRef,
        kind: 'resume' as const, grantRef: f.input.grantRef, grantRevision: f.input.grantRevision, requestKind: f.input.requestKind };
    };
    return { ...f, actions, invoke, current, context, acceptance, accept, continuation };
  } catch (error) { await f.close(); throw error; }
}

it('accepts the real Service Work only after local owner adoption and returns pending Host admission with exact replay', async () => {
  const f = await setup(false); try {
    await expect(f.accept()).rejects.toMatchObject({ code: 'WORK_DELEGATION_UNAVAILABLE' });
    await f.connector.adoptWorkPolicy(f.connection.connectionId, f.owner.userId, f.policy.revision);
    const spy = vi.spyOn(f.connector, 'acceptWork');
    const accepted = await f.invoke('collective.work.accept', { ...f.acceptance, title: '  A  ', intendedOutcome: '  Implement A  ' });
    expect(accepted).toMatchObject({ accountableHumanId: f.serviceOwner.human.humanId, lifecycle: 'committed',
      disposition: 'accepted_pending_host_admission', acceptance: { grantRef: 'owner-grant', grantRevision: 1 } });
    expect(spy).toHaveBeenCalledWith(f.source, f.agent, { ...f.input, title: 'A', intendedOutcome: 'Implement A' });
    expect(await f.invoke('collective.work.accept', { ...f.acceptance, intendedOutcome: 'Implement A' })).toEqual(accepted);
    const works = f.store.listCollectiveCollaboration(f.serviceOwner.sessionToken, f.connection.collectiveId).works;
    expect(works).toHaveLength(1); expect(works[0]?.acceptance?.hostAdmission).toBeUndefined();
    await expect(f.invoke('collective.work.accept', { ...f.acceptance, title: 'Different' })).rejects.toMatchObject({ code: 'COLLABORATION_OPERATION_CONFLICT' });
  } finally { vi.restoreAllMocks(); await f.close(); }
});

it('rejects original invalid bounds, forged identity, context and Work refs before their business effects', async () => {
  const f = await setup(); try {
    const accept = vi.spyOn(f.connector, 'acceptWork'), resume = vi.spyOn(f.connector, 'continueWork');
    for (const extra of [{ catId: 'other' }, { title: ' ' }, { title: 'x'.repeat(201) }, { intendedOutcome: 'x'.repeat(32001) },
      { grantRef: 'x'.repeat(241) }, { grantRevision: 0 }, { requestKind: 'x'.repeat(241) }])
      await expect(f.invoke('collective.work.accept', { ...f.acceptance, ...extra })).rejects.toMatchObject({ code: 'INVALID_COLLECTIVE_REQUEST' });
    await expect(f.invoke('collective.work.accept', { ...f.acceptance, contextRef: 'forged' })).rejects.toMatchObject({ code: 'RETURN_REF_INVALID' });
    await expect(Promise.resolve(f.actions['collective.work.accept']!(f.acceptance))).rejects.toMatchObject({ code: 'NOT_COLLECTIVE_ORIGIN' });
    await expect(f.invoke('collective.work.accept', f.acceptance, { ...f.action, invocationId: 'foreign' })).rejects.toMatchObject({ code: 'RETURN_REF_INVALID' });
    await expect(f.invoke('collective.work.continue', { contextRef: f.context.contextRef, workRef: 'forged', kind: 'resume', ...f.input }))
      .rejects.toMatchObject({ code: 'INVALID_COLLECTIVE_REQUEST' });
    expect(accept).not.toHaveBeenCalled(); expect(resume).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); await f.close(); }
});

it('unknown metadata grants no extra authority and current Work grant revocation is enforced', async () => {
  const f = await setup(); try {
    const spy = vi.spyOn(f.connector, 'acceptWork');
    f.updateFact({ source: { ...f.native.source.source, meta: { ...f.native.source.source.meta, reconsideration: { purposeKey: 'original-purpose' } } } });
    await expect(f.accept()).resolves.toMatchObject({disposition:'accepted_pending_host_admission'}); expect(spy).toHaveBeenCalledOnce();
  } finally { vi.restoreAllMocks(); await f.close(); }
  const g = await setup(); try {
    await g.connector.revokeWorkGrants(g.connection.connectionId, g.owner.userId, ['owner-grant']);
    await expect(g.accept()).rejects.toMatchObject({ code: 'WORK_DELEGATION_UNAVAILABLE' });
    expect(g.store.listCollectiveCollaboration(g.serviceOwner.sessionToken, g.connection.collectiveId).works).toHaveLength(0);
  } finally { await g.close(); }
});

it('recovers one acceptance after a real lost Service response and retains accepted late effects without starting a Task', async () => {
  const f = await setup(); try {
    f.loseResponse(); await expect(f.accept()).rejects.toThrow(/unreachable/);
    expect(f.store.listCollectiveCollaboration(f.serviceOwner.sessionToken, f.connection.collectiveId).works).toHaveLength(1);
    expect(await f.accept()).toMatchObject({ disposition: 'accepted_pending_host_admission' });
    expect(f.store.listCollectiveCollaboration(f.serviceOwner.sessionToken, f.connection.collectiveId).works).toHaveLength(1);
  } finally { await f.close(); }
  const g = await setup(); try {
    const original = g.connector.acceptWork.bind(g.connector);
    vi.spyOn(g.connector, 'acceptWork').mockImplementationOnce(async (...args) => { const work = await original(...args); g.expire(); return work; });
    const sync = vi.spyOn(g.connector, 'sync'); await expect(g.accept()).rejects.toThrow('Caller expired'); expect(sync).not.toHaveBeenCalled();
    expect(g.store.listCollectiveCollaboration(g.serviceOwner.sessionToken, g.connection.collectiveId).works).toHaveLength(1);
  } finally { vi.restoreAllMocks(); await g.close(); }
});

it('continues the original current Work and assignment, rejects stale refs, and recovers with current refs without a second authority', async () => {
  const f = await setup(); try {
    const accepted = await f.accept(); const input = await f.continuation();
    const continued = await f.invoke('collective.work.continue', input);
    expect(continued).toMatchObject({ workId: accepted.workId, assignmentEventId: accepted.assignmentEventId,
      disposition: 'accepted_pending_host_admission', lifecycle: 'in_progress', executionAuthority: { revision: 2, grantRef: 'owner-grant' } });
    await expect(f.invoke('collective.work.continue', input)).rejects.toMatchObject({ code: 'WORK_REVISION_CONFLICT' });
    const current = await f.continuation();
    expect(await f.invoke('collective.work.continue', current)).toEqual(continued);
    const spy = vi.spyOn(f.connector, 'continueWork');
    await expect(f.invoke('collective.work.continue', { ...current, workRef: current.workRef.slice(0, -1) + '!' })).rejects.toMatchObject({ code: 'RETURN_REF_INVALID' });
    await expect(f.invoke('collective.work.continue', { ...current, workId: 'forged' })).rejects.toMatchObject({ code: 'INVALID_COLLECTIVE_REQUEST' });
    expect(spy).not.toHaveBeenCalled();
    const works = f.store.listCollectiveCollaboration(f.serviceOwner.sessionToken, f.connection.collectiveId).works;
    expect(works).toHaveLength(1); expect(works[0]?.executionAuthority?.revision).toBe(2);
  } finally { vi.restoreAllMocks(); await f.close(); }
});

it('rechecks native currentness after reading Work candidates before continuation effects', async () => {
  const f = await setup(); try {
    await f.accept(); const input = await f.continuation();
    const read = f.connector.readWorkSourceContext.bind(f.connector);
    vi.spyOn(f.connector, 'readWorkSourceContext').mockImplementationOnce(async (...args) => { const result = await read(...args); f.expire(); return result; });
    const continueWork = vi.spyOn(f.connector, 'continueWork');
    await expect(f.invoke('collective.work.continue', input)).rejects.toThrow('Caller expired');
    expect(continueWork).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); await f.close(); }
});

it('retains a late committed continuation while refusing its result and never syncs under expired native identity', async () => {
  const f = await setup(); try {
    await f.accept(); const input = await f.continuation(); const original = f.connector.continueWork.bind(f.connector);
    vi.spyOn(f.connector, 'continueWork').mockImplementationOnce(async (...args) => { const result = await original(...args); f.expire(); return result; });
    const sync = vi.spyOn(f.connector, 'sync'); await expect(f.invoke('collective.work.continue', input)).rejects.toThrow('Caller expired');
    expect(sync).not.toHaveBeenCalled();
    expect(f.store.listCollectiveCollaboration(f.serviceOwner.sessionToken, f.connection.collectiveId).works[0]?.executionAuthority?.revision).toBe(2);
  } finally { vi.restoreAllMocks(); await f.close(); }
});

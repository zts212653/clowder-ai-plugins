import { expect, test } from 'vitest';
import { collectiveEventSourceIdentity } from '../../contracts/index.js';
import { fixture } from './communication-work-custody.fixture.js';

const { collectiveWorkContinuation } = process.env.COLLECTIVE_TEST_COMPILED_PRIVATE === '1'
  ? await import('../../../../dist/owner-work-continuation.js')
  : await import('../../../owner-work-continuation.js');

async function assigned(fixtureAdmission = true) {
  const f = await fixture();
  try {
    await f.connector.adoptWorkPolicy(f.connection.connectionId, 'local-owner', f.policy.revision);
    const work = await f.connector.acceptWork(f.source, f.agent, f.input);
    await f.connector.sync(f.connection.connectionId);
    const item = (await f.connector.listInbox(f.connection.connectionId)).find(row => row.event.eventId === work.assignmentEventId);
    if (!item) throw new Error('Expected actual Service assignment in Connector inbox');
    const source = collectiveEventSourceIdentity(item.event);
    if (!source) throw new Error('Expected original assignment source identity');
    // This is a controlled local route receipt, not a Host Task or admission.
    const messageId = 'fixture-assignment-message';
    const route = await f.connector.getHostRoute(f.connection.connectionId);
    if (!route) throw new Error('Expected original route');
    await f.connector.beginInboxRouting(f.connection.connectionId, item.event.eventId, route.revision);
    await f.connector.completeInboxRouting(f.connection.connectionId, item.event.eventId, route.revision,
      { kind: 'thread_message', threadId: 'channel', messageId });
    if (fixtureAdmission) {
      if (!work.acceptance || !work.assignmentEventId) throw new Error('Expected actual Service acceptance coordinates');
      // Fixture-only Service acknowledgement exercises the post-admission branch.
      // No Host receipt/Task is created; this is not a production admission assertion.
      await f.connector.recordHostAdmission(f.connection.connectionId, {
        workId: work.workId, assignmentEventId: work.assignmentEventId, operationRef: work.acceptance.operationRef,
        grantRef: work.acceptance.grantRef, grantRevision: work.acceptance.grantRevision,
        disposition: { state: 'admitted', receiptRef: 'fixture-only-not-a-host-receipt' },
      });
    }
    const scope = await f.connector.withAssignedWorkAuthority(f.connection.connectionId, work.workId, async scope => scope);
    return { ...f, scope, source, messageId, work: scope.work };
  } catch (error) { await f.close(); throw error; }
}

test('original continuation maps a current Service Work with explicit fixture acknowledgement to first result round', async () => {
  const f = await assigned(); try {
    expect(collectiveWorkContinuation(f.scope, f.source, f.messageId)).toEqual({ resultRevision: 1 });
    expect(f.scope.work.acceptance?.hostAdmission?.receiptRef).toBe('fixture-only-not-a-host-receipt');
    expect(f.store.listCollectiveCollaboration(f.owner.sessionToken, f.connection.collectiveId).works).toHaveLength(1);
  } finally { await f.close(); }
});
test('actual Service acceptance pending Host admission remains blocked and cannot become executable by reading it', async () => {
  const f = await assigned(false); try {
    expect(f.scope.work.status).toBe('blocked');
    expect(f.scope.work.acceptance?.hostAdmission).toBeUndefined();
    expect(() => collectiveWorkContinuation(f.scope, f.source, f.messageId)).toThrow();
  } finally { await f.close(); }
});
test('original continuation rejects source, Cat, channel, participation and local message drift', async () => {
  const f = await assigned(); try {
    for (const source of [{ ...f.source, eventId: 'evt_foreign0000' }, { ...f.source, catId: 'foreign-cat' },
      { ...f.source, location: { ...f.source.location, channelId: 'foreign' } },
      { ...f.source, participationRevision: f.source.participationRevision + 1 }])
      expect(() => collectiveWorkContinuation(f.scope, source, f.messageId)).toThrow(/no current executable result round/);
    expect(() => collectiveWorkContinuation(f.scope, f.source, 'foreign-message')).toThrow();
  } finally { await f.close(); }
});
test('original continuation refuses foreign accountable owner, terminal lifecycle and ambiguous assignment receipt', async () => {
  const f = await assigned(); try {
    expect(() => collectiveWorkContinuation({ ...f.scope, work: { ...f.scope.work, accountableHumanId: 'foreign-owner' } }, f.source, f.messageId)).toThrow();
    expect(() => collectiveWorkContinuation({ ...f.scope, work: { ...f.scope.work, lifecycle: 'completed', status: 'completed' } }, f.source, f.messageId)).toThrow();
    const assignment = f.scope.inbox.find(row => row.event.eventId === f.source.eventId)!;
    expect(() => collectiveWorkContinuation({ ...f.scope, inbox: [...f.scope.inbox, assignment] }, f.source, f.messageId)).toThrow();
  } finally { await f.close(); }
});

test('original continuation maps the current Service execution notice and rejects a stale first assignment', async () => {
  const f = await assigned(); try {
    const continued = await f.connector.continueWork(f.source, f.agent, { workId: f.work.workId,
      expectedRevision: f.work.revision, kind: 'resume', grantRef: f.input.grantRef,
      grantRevision: f.input.grantRevision, requestKind: f.input.requestKind });
    const authority = continued.executionAuthority;
    if (!authority || !continued.assignmentEventId) throw new Error('Expected actual Service continuation coordinates');
    expect(authority.revision).toBe(2);
    await f.connector.sync(f.connection.connectionId);
    const item = (await f.connector.listInbox(f.connection.connectionId)).find(row => row.event.eventId === authority.eventId);
    if (!item) throw new Error('Expected actual current execution notice');
    const source = collectiveEventSourceIdentity(item.event);
    if (!source) throw new Error('Expected execution source');
    const route = await f.connector.getHostRoute(f.connection.connectionId);
    if (!route) throw new Error('Expected existing route');
    const messageId = 'fixture-current-execution-message';
    await f.connector.beginInboxRouting(f.connection.connectionId, item.event.eventId, route.revision);
    await f.connector.completeInboxRouting(f.connection.connectionId, item.event.eventId, route.revision,
      { kind: 'thread_message', threadId: 'channel', messageId });
    // Same explicit Service-only acknowledgement fixture as above, never a Host Task.
    await f.connector.recordHostAdmission(f.connection.connectionId, { workId: continued.workId,
      assignmentEventId: continued.assignmentEventId, operationRef: authority.operationRef,
      grantRef: authority.grantRef, grantRevision: authority.grantRevision, executionRevision: authority.revision,
      disposition: { state: 'admitted', receiptRef: 'fixture-only-current-execution-receipt' } });
    await f.connector.withAssignedWorkAuthority(f.connection.connectionId, continued.workId, async scope => {
      expect(collectiveWorkContinuation(scope, source, messageId)).toMatchObject({
        resultRevision: authority.resultRevision, feedbackEventId: authority.sourceEventId });
      expect(() => collectiveWorkContinuation(scope, f.source, f.messageId)).toThrow();
      expect(() => collectiveWorkContinuation({ ...scope, work: { ...scope.work,
        executionAuthority: { ...scope.work.executionAuthority!, resultRevision: authority.resultRevision + 1 } } }, source, messageId)).toThrow();
    });
  } finally { await f.close(); }
});

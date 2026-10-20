import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { collectiveEventSourceIdentity } from '../../contracts/index.js';
import { fixture } from './communication-work-custody.fixture.js';

const { publishCollectiveProgress } = process.env.COLLECTIVE_TEST_COMPILED_PRIVATE === '1'
  ? await import('../../../../dist/owner-work-progress.js')
  : await import('../../../owner-work-progress.js');

async function admittedServiceWork() {
  const f = await fixture();
  try {
    await f.connector.adoptWorkPolicy(f.connection.connectionId, 'local-owner', f.policy.revision);
    const work = await f.connector.acceptWork(f.source, f.agent, f.input);
    if (!work.acceptance || !work.assignmentEventId) throw new Error('Expected actual Service assignment');
    // Service acknowledgement only: this fixture creates no Host Task or receipt.
    await f.connector.recordHostAdmission(f.connection.connectionId, {
      workId: work.workId, assignmentEventId: work.assignmentEventId,
      operationRef: work.acceptance.operationRef, grantRef: work.acceptance.grantRef,
      grantRevision: work.acceptance.grantRevision,
      disposition: { state: 'admitted', receiptRef: 'fixture-only-not-a-host-receipt' },
    });
    await f.connector.sync(f.connection.connectionId);
    const assignment = (await f.connector.listInbox(f.connection.connectionId))
      .find(row => row.event.eventId === work.assignmentEventId);
    const source = assignment && collectiveEventSourceIdentity(assignment.event);
    if (!source) throw new Error('Expected actual assignment source');
    return { ...f, work, binding: {
      source, sourceRef: 'message:fixture-assignment-message',
      resultKey: 'work:fixture-only-host-task', displayName: f.agent.displayName,
      // These are explicit private-Host context fixtures, not read/admission authority.
      work: { revision: 1, resultRevision: 1, executionRevision: 1, assignmentEventId: work.assignmentEventId },
    }, auth: { catId: f.agent.catId, invocationId: f.agent.sessionRef } };
  } catch (error) { await f.close(); throw error; }
}

test('original progress caller publishes a versioned Service receipt without completing Work, and replay reuses the outbox', async () => {
  const f = await admittedServiceWork();
  try {
    const first = await publishCollectiveProgress(f.connector, f.auth, f.binding, 'Checking the original result.');
    expect(first).toMatchObject({ status: 'accepted', receipt: {
      workId: f.work.workId, assignmentEventId: f.work.assignmentEventId,
      resultRevision: 1, executionRevision: 1,
    } });
    expect(first.eventId).toBeDefined();
    const retry = await publishCollectiveProgress(f.connector, f.auth, f.binding, 'Checking the original result.');
    expect(retry).toEqual(first);
    const state = JSON.parse(await readFile(join(f.root, 'connector', 'collective-connector.json'), 'utf8'));
    expect(state.connections[f.connection.connectionId].outbox).toHaveLength(1);
    const current = await f.connector.readAssignedWork(f.connection.connectionId, f.work.workId);
    expect(current.resultEventId).toBeUndefined();
    expect(current.lifecycle).not.toBe('completed');
  } finally { await f.close(); }
});

test('original progress caller refuses a foreign or unverified executing Cat', async () => {
  const f = await admittedServiceWork();
  try {
    await expect(publishCollectiveProgress(f.connector, { ...f.auth, catId: 'foreign-cat' }, f.binding, 'Cannot borrow author.'))
      .rejects.toThrow();
    await expect(publishCollectiveProgress(f.connector, { ...f.auth, invocationId: 'unverified-turn' }, f.binding, 'Cannot borrow session.'))
      .rejects.toThrow();
    expect((await f.connector.listInbox(f.connection.connectionId)).some(row => row.event.workProgressReceipt)).toBe(false);
  } finally { await f.close(); }
});

test('original progress caller refuses stale participation and current execution revision drift', async () => {
  const f = await admittedServiceWork();
  try {
    await expect(publishCollectiveProgress(f.connector, f.auth, {
      ...f.binding, source: { ...f.binding.source, participationRevision: f.binding.source.participationRevision + 1 },
    }, 'Stale participant.')).rejects.toThrow();
    const result = await publishCollectiveProgress(f.connector, f.auth, {
      ...f.binding, work: { ...f.binding.work, executionRevision: 2 },
    }, 'Unissued execution.');
    expect(result.status).toBe('blocked');
    expect(result.code).toBe('WORK_EXECUTION_NOT_CURRENT');
    expect(result.receipt).toBeUndefined();
  } finally { await f.close(); }
});

test('original progress caller binds a real Service continuation to its current execution notice and round', async () => {
  const f = await admittedServiceWork();
  try {
    const before = await f.connector.readAssignedWork(f.connection.connectionId, f.work.workId);
    const continued = await f.connector.continueWork(f.source, f.agent, {
      workId: before.workId, expectedRevision: before.revision, kind: 'resume',
      grantRef: f.input.grantRef, grantRevision: f.input.grantRevision, requestKind: f.input.requestKind,
    });
    const authority = continued.executionAuthority;
    if (!authority || !continued.assignmentEventId) throw new Error('Expected actual continuation');
    await f.connector.recordHostAdmission(f.connection.connectionId, {
      workId: continued.workId, assignmentEventId: continued.assignmentEventId,
      operationRef: authority.operationRef, grantRef: authority.grantRef, grantRevision: authority.grantRevision,
      executionRevision: authority.revision,
      disposition: { state: 'admitted', receiptRef: 'fixture-only-current-execution-receipt' },
    });
    await f.connector.sync(f.connection.connectionId);
    const notice = (await f.connector.listInbox(f.connection.connectionId))
      .find(row => row.event.eventId === authority.eventId);
    const source = notice && collectiveEventSourceIdentity(notice.event);
    if (!source) throw new Error('Expected actual continuation source');
    const result = await publishCollectiveProgress(f.connector, f.auth, {
      ...f.binding, source, sourceRef: 'message:fixture-continuation-message',
      work: { revision: 2, resultRevision: authority.resultRevision,
        executionRevision: authority.revision, assignmentEventId: continued.assignmentEventId },
    }, 'Checking the current execution.');
    expect(result).toMatchObject({ status: 'accepted', receipt: {
      workId: f.work.workId, executionRevision: 2, resultRevision: authority.resultRevision,
    } });
    const stale = await publishCollectiveProgress(f.connector, f.auth, f.binding, 'The old execution cannot publish.');
    expect(stale.status).toBe('blocked');
    expect(stale.receipt).toBeUndefined();
    const current = await f.connector.readAssignedWork(f.connection.connectionId, f.work.workId);
    expect(current.resultEventId).toBeUndefined();
    expect(f.store.listCollectiveCollaboration(f.owner.sessionToken, f.connection.collectiveId).works).toHaveLength(1);
  } finally { await f.close(); }
});

test('original progress caller cannot turn revoked Service permission into a progress receipt', async () => {
  const f = await admittedServiceWork();
  try {
    await f.connector.revokeWorkGrants(f.connection.connectionId, 'local-owner', [f.input.grantRef]);
    const result = await publishCollectiveProgress(f.connector, f.auth, f.binding, 'No revoked permission.');
    expect(result.status).toBe('blocked');
    expect(result.receipt).toBeUndefined();
    expect((await f.connector.listInbox(f.connection.connectionId)).some(row => row.event.workProgressReceipt)).toBe(false);
  } finally { await f.close(); }
});

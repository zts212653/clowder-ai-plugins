import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './helpers/team-fixture.js';

async function analyzed(s: ReturnType<typeof setup>, r = s.runtime()) {
  const job = await r.invoke('analyze', { repo: 'fixture/repo', number: 1, requestId: 'group-test' }, s.caller('requester')) as any;
  return { r, job: await r.invoke('submit', { id: job.id, analysis: s.analysis }, s.caller()) as any };
}

test('a routing rule cannot turn a non-group user into a worker; unconfigured groups do not dispatch', async () => {
  for (const members of ['bob', '', undefined]) {
    const s = setup();
    s.members.splice(0, s.members.length, ...(members ? members.split(',') : []));
    if (members === undefined) delete s.config.teamOrganization;
    const { job } = await analyzed(s);
    assert.equal(s.writes.length, 0);
    assert.equal(s.dispatches.length, 0);
    assert.match(job.assignment.reason, /group|member|成员|组/i);
    assert.ok(job.analysis, 'analysis remains available without assignment');
  }
});

test('a member reporter takes priority over Feature routing without changing the classification', async () => {
  const s = setup();
  s.members.splice(0, s.members.length, 'Alice', 'BOB');
  s.issues[0].author = 'bob';
  s.issues[0].labels = ['feature:F123'];
  s.provider.assignable = async () => true;
  const { r, job } = await analyzed(s);
  assert.deepEqual(s.writes, ['bob']);
  assert.deepEqual(job.features, ['F123']);
  assert.equal(job.assignment.basis, 'reporter');
  assert.equal(s.dispatches[0].acceptanceSuggestedFor, 'bob');
  const detail = await r.invoke('get', { id: job.id }, s.caller()) as any;
  assert.equal(detail.assignmentOptions.acceptanceSuggestedFor, 'bob');
  assert.equal(detail.feedback, undefined, 'acceptance suggestion is not acceptance');
  await s.runtime().recover();
  assert.deepEqual(s.writes, ['bob'], 'restart must not choose the category owner again');
});

test('an outside or unavailable reporter never becomes a worker implicitly', async () => {
  const s = setup(); s.issues[0].author = 'outsider';
  const { job } = await analyzed(s);
  assert.deepEqual(s.writes, ['alice']);
  assert.equal(job.assignment.basis, 'category');
  assert.equal(s.dispatches[0].acceptanceSuggestedFor, undefined);

  const unavailable = setup(); unavailable.issues[0].author = 'bob';
  const result = await analyzed(unavailable);
  assert.equal(unavailable.writes.length, 0, 'cannot silently replace the member reporter when GitHub refuses them');
  assert.match(result.job.assignment.reason, /assign/i);
});

test('member removal while permission checks are pending blocks both assignment and publication', async () => {
  const s = setup();
  s.provider.assignable = async () => { s.members.splice(0, s.members.length, 'bob'); return true; };
  await analyzed(s);
  assert.equal(s.writes.length, 0);
  assert.equal(s.dispatches.length, 0);

  const changedAfterAssign = setup();
  const add = changedAfterAssign.provider.addAssignee;
  changedAfterAssign.provider.addAssignee = async (...args) => {
    await add(...args);
    changedAfterAssign.members.splice(0, changedAfterAssign.members.length, 'bob');
  };
  await analyzed(changedAfterAssign);
  assert.deepEqual(changedAfterAssign.writes, ['alice']);
  assert.equal(changedAfterAssign.dispatches.length, 0, 'do not publish a removed member as a valid new dispatch');
});

test('confirmed republish cannot bypass current group membership', async () => {
  const s = setup(), r = s.runtime();
  s.config.analysisThreadId = 'analysis';
  s.provider.publishDispatch = async () => { throw new Error('response lost'); };
  const { job } = await analyzed(s, r);
  const detail = await r.invoke('get', { id: job.id }, s.caller()) as any;
  s.members.splice(0, s.members.length, 'bob');
  let publications = 0;
  s.provider.publishDispatch = async () => { publications++; return 'comment'; };
  await assert.rejects(r.invokeOwner('republish', { id: job.id, expectedRevision: detail.revision }, {
    kind: 'owner-operation', pluginInstanceId: s.context.pluginInstanceId, operationKey: 'teamWorkbench',
    actionId: 'republish', userId: 'owner', requestId: 'republish',
    signal: new AbortController().signal, async assertCurrent() {},
  }), /group|member|成员|组/i);
  assert.equal(publications, 0);
});

test('receiver team must belong to the group before collecting assigned work', async () => {
  const s = setup();
  s.login('outsider'); s.issues[0].assignees = ['outsider'];
  await s.runtime().recover();
  assert.equal(s.sends.size, 0);
  assert.deepEqual(await s.context.storage.list(), {});
});

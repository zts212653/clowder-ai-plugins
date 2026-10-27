import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './helpers/team-fixture.js';

function fixture() {
  const s = setup();
  s.config.analysisThreadId = 'analysis';
  s.config.receiveAssignments = false;
  s.config.automaticAssignment = false;
  s.issues.push({ ...structuredClone(s.issues[0]), id: 'issue-2', number: 2, url: 'https://github.com/fixture/repo/issues/2' });
  const call = (runtime: ReturnType<typeof s.runtime>, method: string, input = {}) => runtime.invokeOwner(method, input, {
    kind: 'owner-operation', userId: 'owner', pluginInstanceId: 'isolated-test',
    operationKey: 'teamWorkbench', actionId: method, requestId: 'operation-' + method,
    signal: new AbortController().signal, assertCurrent: async () => {},
  }) as Promise<any>;
  const plan = (runtime: ReturnType<typeof s.runtime>) => call(runtime, 'planClassification', {
    repo: 'fixture/repo', catId: 'receiver', requestId: 'batch-1',
  });
  const control = (runtime: ReturnType<typeof s.runtime>, queue: any, status: string) => call(runtime,
    'controlClassification', { id: queue.id, expectedRevision: queue.revision, status });
  return { ...s, call, plan, control };
}

test('classification queue plans without sending, runs serially and resumes the same jobs after restart', async () => {
  const s = fixture(); let runtime = s.runtime();
  const plan = await s.plan(runtime);
  assert.equal(plan.items.length, 2);
  assert.equal(plan.status, 'paused');
  assert.equal(s.sends.size, 0);
  assert.equal((await s.plan(runtime)).id, plan.id);
  let queue = await s.control(runtime, plan, 'running');
  assert.equal(s.sends.size, 1);
  assert.equal([...s.sends.values()][0].draft.wake.catId, 'receiver');
  const first = queue.items[0].jobId;
  await runtime.stop(); runtime = s.runtime();
  await runtime.recover();
  assert.equal(s.sends.size, 1, 'restart waits for the existing analysis');
  await runtime.invoke('submit', { id: first, analysis: s.analysis }, s.caller('receiver'));
  await runtime.recover();
  queue = (await s.call(runtime, 'summary')).classificationQueues[0];
  assert.equal(s.sends.size, 2);
  assert.equal(queue.items[0].status, 'analyzed');
  await runtime.invoke('submit', { id: queue.items[1].jobId, analysis: s.analysis }, s.caller('receiver'));
  await runtime.recover();
  queue = (await s.call(runtime, 'summary')).classificationQueues[0];
  assert.equal(queue.status, 'completed');
  assert.equal(queue.items.filter((item: any) => item.status === 'analyzed').length, 2);
  assert.deepEqual(s.writes, []);
  await runtime.stop();
});

test('pause stops automatic dispatch and new analyses; resuming requires the current queue revision', async () => {
  const s = fixture(); const runtime = s.runtime();
  s.config.automaticAssignment = true;
  s.issues[0].author = 'alice';
  const plan = await s.plan(runtime);
  const running = await s.control(runtime, plan, 'running');
  const paused = await s.control(runtime, running, 'paused');
  await runtime.invoke('submit', { id: paused.items[0].jobId, analysis: s.analysis }, s.caller('receiver'));
  await runtime.recover();
  assert.deepEqual(s.writes, []);
  assert.equal(s.sends.size, 1);
  await assert.rejects(s.control(runtime, running, 'running'), /changed|revision/i);
  await s.control(runtime, paused, 'running');
  await runtime.recover();
  assert.deepEqual(s.writes, ['alice']);
  assert.equal(s.sends.size, 2);
  await runtime.stop();
});

test('a queue preserves its chosen cat and blocks new work after routing or source authorization changes', async () => {
  const s = fixture(); const runtime = s.runtime();
  const plan = await s.plan(runtime);
  s.config.analysisCatId = 'analyst';
  s.routable(false);
  await assert.rejects(s.control(runtime, plan, 'running'), /routable|unavailable/i);
  assert.equal(s.sends.size, 0);
  s.routable(true);
  const running = await s.control(runtime, plan, 'running');
  s.config.repositories = 'other/repo';
  await assert.rejects(s.call(runtime, 'controlClassification', {
    id: running.id, expectedRevision: running.revision, status: 'running',
  }), /Repository|enabled/i);
  assert.equal(s.sends.size, 1);
  assert.equal([...s.sends.values()][0].draft.wake.catId, 'receiver');
  await runtime.stop();
});

test('stopped queues do not send pending work on restart and a partial catalog creates no queue', async () => {
  const s = fixture(); const runtime = s.runtime();
  s.config.automaticAssignment = true;
  const plan = await s.plan(runtime);
  const running = await s.control(runtime, plan, 'running');
  await s.control(runtime, running, 'stopped');
  await runtime.invoke('submit', { id: running.items[0].jobId, analysis: s.analysis }, s.caller('receiver'));
  await runtime.stop();
  const resumed = s.runtime(); await resumed.recover();
  assert.equal(s.sends.size, 1);
  assert.deepEqual(s.writes, [], 'a stopped batch cannot assign a late result');
  s.provider.openIssues = async () => { throw new Error('Incomplete GitHub pagination'); };
  await assert.rejects(s.call(resumed, 'planClassification', {
    repo: 'fixture/repo', catId: 'receiver', requestId: 'batch-2',
  }), /Incomplete/);
  assert.equal((await s.call(resumed, 'summary')).classificationQueues.length, 1);
  await resumed.stop();
});

test('catalog retrieval cannot outlive owner or repository authorization, and closed queued issues are skipped', async () => {
  const s = fixture(); const runtime = s.runtime();
  const catalog = s.provider.openIssues;
  s.provider.openIssues = async (...args) => {
    s.config.repositories = 'other/repo'; return catalog(...args);
  };
  await assert.rejects(s.plan(runtime), /enabled/);
  assert.equal(Object.keys(await s.context.storage.list()).length, 0);
  s.config.repositories = 'fixture/repo';
  let valid = true;
  s.provider.openIssues = async (...args) => { valid = false; return catalog(...args); };
  await assert.rejects(runtime.invokeOwner('planClassification', { repo: 'fixture/repo', catId: 'receiver', requestId: 'expires' }, {
    kind: 'owner-operation', userId: 'owner', pluginInstanceId: 'isolated-test', operationKey: 'teamWorkbench',
    actionId: 'planClassification', requestId: 'expires', signal: new AbortController().signal,
    assertCurrent: async () => { if (!valid) throw new Error('Owner authority expired'); },
  }), /expired/);
  assert.equal(Object.keys(await s.context.storage.list()).length, 0);
  s.provider.openIssues = catalog;
  const plan = await s.plan(runtime);
  s.issues[0].state = 'closed';
  const running = await s.control(runtime, plan, 'running');
  assert.equal(running.items[0].status, 'skipped');
  assert.equal(s.sends.size, 1);
  assert.equal(Object.values(await s.context.storage.list()).map(row => row.value as any)
    .find(row => row.kind === 'analysis').issue.number, 2);
  await runtime.stop();
});

test('pause from an overlapping Host instance fences a send waiting on source retrieval', async () => {
  const s = fixture(); const runtime = s.runtime(), other = s.runtime();
  const plan = await s.plan(runtime);
  const originalIssue = s.provider.issue;
  let calls = 0;
  s.provider.issue = async (...args) => {
    if (++calls === 2) {
      const current = (await s.call(other, 'summary')).classificationQueues[0];
      await s.control(other, current, 'paused');
    }
    return originalIssue(...args);
  };
  await assert.rejects(s.control(runtime, plan, 'running'), /changed/i);
  assert.equal((await s.call(other, 'summary')).classificationQueues[0].status, 'paused');
  assert.equal(s.sends.size, 0);
  await runtime.stop(); await other.stop();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { autoMergeDelivery } from '../src/auto-merge.mjs';
import { synchronize } from '../src/automation.mjs';
import { Receiver } from '../src/engine.mjs';
import { runExecution } from '../src/execution.mjs';
import { setIssueToken } from '../src/issue-auth.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { codehubPlatform } from './codehub-fixture.mjs';
import { repositories } from './fixtures.mjs';

async function fixture(t, lost) {
  const f = await repositories(),
    p = await codehubPlatform(f, { lost });
  t.after(p.close);
  const adapter = {
    mode: 'gitlab',
    apiUrl: p.api,
    projectId: 'team/core',
    authMode: 'session',
  };
  const config = {
    ...f.config,
    internalWebUrl: p.web,
    issues: adapter,
    pullRequests: { ...adapter },
    commitStrategy: 'rewrite',
  };
  const receiver = new Receiver(config);
  setIssueToken(receiver.config, p.token, 'test');
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue(f.plans);
  return { ...f, p, receiver, config };
}
const run = (receiver, autoMerge) =>
  synchronize(receiver, {
    action: 'synchronize',
    requestId: 'a'.repeat(32),
    continuation: 'after-each',
    ...(autoMerge === undefined ? {} : { autoMerge }),
  });

test('automatic merge is off by default and opt-in merges one checked PR per explicit boundary', async (t) => {
  const f = await fixture(t);
  await run(f.receiver);
  assert.equal(f.p.state.merges, 0);
  assert.equal((await f.receiver.status()).active.status, 'WAITING_APPROVAL');
  const g = await fixture(t);
  await run(g.receiver, true);
  let state = await g.receiver.status();
  assert.equal(g.p.state.merges, 1);
  assert.equal(state.deliveries[0].status, 'COMPLETE');
  assert.equal(state.automation.status, 'PAUSED');
  assert.equal(g.p.state.creates.prs, 1);
  await synchronize(g.receiver, {
    action: 'resume-sync',
    runId: state.automation.id,
  });
  state = await g.receiver.status();
  assert.equal(g.p.state.merges, 2);
  assert.equal(g.p.state.closes, 1);
  assert.equal(state.deliveries[1].status, 'COMPLETE');
});

test('enabling automatic merge for an already waiting PR completes that delivery before its pause boundary', async (t) => {
  const f = await fixture(t);
  await run(f.receiver);
  let state = await f.receiver.status();
  assert.equal(state.automation.status, 'WAITING_REVIEW');
  assert.equal(f.p.state.merges, 0);

  await synchronize(f.receiver, {
    action: 'configure-auto-merge',
    runId: state.automation.id,
    deliveryId: state.active.id,
    autoMerge: true,
  });
  await synchronize(f.receiver, {
    action: 'resume-sync',
    runId: state.automation.id,
  });

  state = await f.receiver.status();
  assert.equal(f.p.state.merges, 1);
  assert.equal(state.deliveries[0].status, 'COMPLETE');
  assert.equal(state.automation.status, 'PAUSED');
  assert.equal(state.queue.length, 1, 'the boundary pauses before starting the next delivery');
});

test('automation can save its run state after the bound delivery becomes terminal', async (t) => {
  const f = await fixture(t);
  await run(f.receiver);
  const state = await f.receiver.status();
  const context = {
    signal: new AbortController().signal,
    deliveryId: state.active.id,
    report() {},
    associate(id) {
      this.deliveryId = id;
    },
  };
  await synchronize(f.receiver, {
    action: 'configure-auto-merge',
    runId: state.automation.id,
    deliveryId: state.active.id,
    autoMerge: true,
  });

  await runExecution(context, () =>
    synchronize(f.receiver, {
      action: 'resume-sync',
      runId: state.automation.id,
    }),
  );

  const result = await f.receiver.status();
  assert.equal(f.p.state.merges, 1);
  assert.equal(result.deliveries[0].status, 'COMPLETE');
  assert.equal(result.automation.status, 'PAUSED');
});

test('a lost applied merge receipt recovers after restart by reading the same PR and Git result', async (t) => {
  const f = await fixture(t, 'merge');
  await run(f.receiver, true);
  assert.equal(f.p.state.merges, 1);
  const receiver = new Receiver(f.config),
    state = await receiver.status();
  await synchronize(receiver, {
    action: 'resume-sync',
    runId: state.automation.id,
  });
  assert.equal((await receiver.status()).deliveries[0].status, 'COMPLETE');
  assert.equal(f.p.state.merges, 1);
});

test('platform merge restrictions never become direct Git pushes or successful acceptance', async (t) => {
  const f = await fixture(t);
  f.p.state.denyMerge = true;
  await assert.rejects(() => run(f.receiver, true), {
    code: 'PR_API_REJECTED',
  });
  const state = await f.receiver.status();
  assert.equal(state.accepted.internal, f.i0);
  assert.equal(state.automation.status, 'FAILED');
  assert.equal(f.p.state.merges, 0);
  assert.equal(f.p.state.creates.prs, 1);
});

test('pending CI remains a resumable wait and later success merges without repeating PR creation', async (t) => {
  const f = await fixture(t);
  await run(f.receiver);
  const state = await f.receiver.status();
  await synchronize(f.receiver, {
    action: 'configure-auto-merge',
    runId: state.automation.id,
    deliveryId: state.active.id,
    autoMerge: true,
  });
  const mr = f.p.state.mrs[0];
  mr.head_pipeline = { id: 10, sha: mr.sha, status: 'pending' };
  await synchronize(f.receiver, {
    action: 'resume-sync',
    runId: state.automation.id,
  });
  let waiting = await f.receiver.status();
  assert.equal(waiting.automation.status, 'WAITING_REVIEW');
  assert.equal(waiting.active.autoMerge.status, 'WAITING');
  assert.equal(f.p.state.merges, 0);
  mr.head_pipeline.status = 'success';
  await synchronize(f.receiver, {
    action: 'resume-sync',
    runId: state.automation.id,
  });
  waiting = await f.receiver.status();
  assert.equal(waiting.deliveries[0].status, 'COMPLETE');
  assert.equal(f.p.state.creates.prs, 1);
  assert.equal(f.p.state.merges, 1);
});

test('background observations do not create polling tasks; restart later accepts the same delayed merge exactly once', async (t) => {
  const f = await fixture(t);
  f.p.state.pipelineStatus = 'pending';
  await run(f.receiver, true);
  let server = createReceiverServer(f.receiver, { syncInterval: 50 });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  let url = `http://127.0.0.1:${server.address().port}/api/status`;
  await fetch(url);
  const initial = await f.receiver.status();
  await f.receiver.change((s) => {
    s.deliveries[0].autoMerge.nextCheckAt = new Date(0).toISOString();
  });
  for (let i = 0; i < 100 && (await f.receiver.status()).active.autoMerge.pollCount < 2; i++)
    await new Promise((done) => setTimeout(done, 20));
  assert.equal((await (await fetch(url)).json()).operation, null, 'no task per unchanged CI observation');
  await server.shutdown();
  const receiver = new Receiver(f.config);
  f.p.state.mrs[0].head_pipeline.status = 'success';
  f.p.state.deferMerge = true;
  await synchronize(receiver, {
    action: 'resume-sync',
    runId: initial.automation.id,
  });
  assert.equal((await receiver.status()).active.autoMerge.status, 'RESULT_PENDING');
  await autoMergeDelivery(receiver, { observeOnly: true });
  const writes = () => f.p.state.requests.filter((r) => r.startsWith('PUT ') && r.endsWith('/merge')).length;
  assert.equal(writes(), 1);
  const active = (await receiver.status()).active;
  await f.merge(active);
  f.p.state.mrs[0].state = 'merged';
  await receiver.change((s) => {
    s.deliveries[0].autoMerge.nextCheckAt = new Date(0).toISOString();
  });
  server = createReceiverServer(new Receiver(f.config), { syncInterval: 50 });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  url = `http://127.0.0.1:${server.address().port}/api/status`;
  await fetch(url);
  for (let i = 0; i < 1500 && (await receiver.status()).automation.status !== 'PAUSED'; i++)
    await new Promise((done) => setTimeout(done, 30));
  assert.equal((await receiver.status()).deliveries[0].status, 'COMPLETE');
  assert.equal((await receiver.status()).automation.status, 'PAUSED');
  assert.equal(writes(), 1);
  assert.equal(f.p.state.creates.prs, 1);
});

test('waiting timeout requires explicit resume and never removes the original PR or candidate', async (t) => {
  const f = await fixture(t);
  f.p.state.pipelineStatus = 'running';
  await run(f.receiver, true);
  const initial = await f.receiver.status();
  await f.receiver.change((s) => {
    s.deliveries[0].autoMerge.deadlineAt = new Date(0).toISOString();
  });
  await assert.rejects(() => autoMergeDelivery(f.receiver), {
    code: 'AUTO_MERGE_BLOCKED',
  });
  await synchronize(f.receiver, {
    action: 'resume-sync',
    runId: initial.automation.id,
  });
  const state = await f.receiver.status();
  assert.equal(state.active.prUrl, initial.active.prUrl);
  assert.equal(state.active.candidate, initial.active.candidate);
  assert.equal(state.automation.status, 'WAITING_REVIEW');
  assert.equal(f.p.state.merges, 0);
});

test('successful merge request with failed readback remains pending and recovery never repeats PUT', async (t) => {
  const f = await fixture(t);
  f.receiver.config.autoMergeWaitMs = 60000;
  f.p.state.deferMerge = true;
  f.p.state.failReadback = true;
  await run(f.receiver, true);
  let s = await f.receiver.status();
  assert.equal(s.automation.status, 'WAITING_REVIEW');
  assert.equal(s.active.autoMerge.status, 'RESULT_PENDING');
  assert.ok(Date.parse(s.active.autoMerge.deadlineAt) - Date.now() <= 60000);
  const receiver = new Receiver(f.config);
  await synchronize(receiver, {
    action: 'resume-sync',
    runId: s.automation.id,
  });
  s = await receiver.status();
  assert.equal(s.active.autoMerge.status, 'RESULT_PENDING');
  assert.equal(f.p.state.requests.filter((r) => r.startsWith('PUT ') && r.endsWith('/merge')).length, 1);
});

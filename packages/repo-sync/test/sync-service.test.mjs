import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatch } from '../src/actions.mjs';
import { Receiver } from '../src/engine.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { gitPrFixture } from './git-pr-fixtures.mjs';

const wait = async (predicate) => {
  for (let retry = 0; retry < 150; retry++) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 200));
  }
  assert.fail('background acceptance did not finish');
};
test('server restarts without a browser and accepts original PR in the background', async () => {
  const f = await gitPrFixture(),
    receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.selectTag('v2.0.0');
  let server = createReceiverServer(receiver, { syncInterval: 50 });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const snapshot = await (await fetch(`${base}/api/status`)).json();
    const request = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Repo-Sync-Token': snapshot.token },
      body: JSON.stringify({
        action: 'synchronize',
        requestId: 'c'.repeat(32),
        expectedBinding: receiver.config.bindingId,
      }),
    });
    assert.equal(request.status, 202);
    await wait(async () => (await receiver.status()).automation?.status === 'WAITING_REVIEW');
    const original = (await receiver.status()).active;
    await server.shutdown();
    await f.merge(original);
    server = createReceiverServer(new Receiver(f.config), { syncInterval: 50 });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    await wait(async () => (await receiver.status()).automation?.status === 'COMPLETE');
    const state = await receiver.status();
    assert.equal(state.deliveries[0].candidate, original.candidate);
    assert.equal(state.deliveries[0].prUrl, original.prUrl);
    assert.equal(state.accepted.upstream, f.u1);
    assert.equal(state.deliveries.length, 1);
  } finally {
    await server.shutdown();
  }
});

test('stale automatic intent cannot be replaced or paused with another run identity', async () => {
  const f = await gitPrFixture(),
    receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.selectTag('v2.0.0');
  await dispatch(receiver, { action: 'synchronize', requestId: 'd'.repeat(32) });
  const original = (await receiver.status()).active;
  await receiver.linkPr(null, { previousUrl: original.prUrl });
  assert.equal((await receiver.status()).automation.status, 'PAUSED');
  await receiver.linkPr(original.prUrl, { previousUrl: '' });
  await dispatch(receiver, { action: 'resume-sync', runId: 'd'.repeat(32) });
  assert.equal((await receiver.status()).automation.status, 'WAITING_REVIEW');
  assert.equal((await receiver.status()).active.candidate, original.candidate);
  await assert.rejects(() => dispatch(receiver, { action: 'pause-sync', runId: 'e'.repeat(32) }), {
    code: 'AUTOMATION_CHANGED',
  });
  await dispatch(receiver, { action: 'pause-sync', runId: 'd'.repeat(32) });
  const waiting = await receiver.status();
  assert.equal(waiting.automation.status, 'WAITING_REVIEW');
  assert.equal(waiting.automation.pauseRequested.afterDeliveryId, original.id);
  assert.equal(waiting.automation.continuation, 'after-each');
  // A duplicate synchronize at review reuses the original run; it cannot replace
  // its identity, frozen target or pending boundary request.
  await dispatch(receiver, { action: 'synchronize', requestId: 'e'.repeat(32) });
  assert.equal((await receiver.status()).automation.id, 'd'.repeat(32));
  assert.equal((await receiver.status()).automation.pauseRequested.afterDeliveryId, original.id);
  assert.equal((await receiver.status()).deliveries.length, 1);
});

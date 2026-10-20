import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Receiver } from '../src/engine.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { versionRepositories } from './version-fixtures.mjs';

test('withdrawal write failures are visible, survive restart and can resume without losing the candidate', async (t) => {
  const f = await versionRepositories();
  const receiver = new Receiver({ ...f.config, internalWebUrl: 'https://web.codehub.example/team/core' });
  await receiver.adopt(f.u0, f.i0);
  await receiver.selectTag('v2.0.0');
  await receiver.start();
  await receiver.prepare();
  const url = 'https://web.codehub.example/team/core/merge_requests/501';
  await receiver.linkPr(url);
  const before = await receiver.status();
  let server;
  let base;
  let headers;
  const startServer = async (bound) => {
    server = createReceiverServer(bound);
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${server.address().port}`;
    const bootstrap = await fetch(`${base}/api/status`).then((response) => response.json());
    headers = { 'X-Repo-Sync-Token': bootstrap.token };
  };
  await startServer(receiver);
  const rename = fs.rename;
  let denied = true;
  let attempts = 0;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === receiver.store.path) {
      attempts++;
      if (denied || attempts < 3) throw Object.assign(new Error('secret path and internal log'), { code: 'EACCES' });
    }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  t.after(async () => {
    await server.shutdown();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const withdraw = async (requestId) => {
    const response = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: 'clear-pr',
        requestId,
        expectedBinding: receiver.config.bindingId,
        deliveryId: before.active.id,
        previousUrl: url,
      }),
    });
    assert.equal(response.status, 202);
    let task;
    for (let count = 0; count < 500; count++) {
      task = await fetch(`${base}/api/tasks/${requestId}`, { headers }).then((response) => response.json());
      if (!['RUNNING', 'CANCELLING'].includes(task.operation.status)) return task.operation;
      await delay(10);
    }
    throw new Error('task did not finish');
  };
  const failed = await withdraw('a'.repeat(32));
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.error.code, 'LEDGER_WRITE_FAILED');
  assert.doesNotMatch(JSON.stringify(failed), /secret path|internal log/);
  assert.equal(failed.steps.find((step) => step.label === '保存交付台账').status, 'FAILED');
  const status = await fetch(`${base}/api/status`).then((response) => response.json());
  assert.equal(status.state.active.prUrl, url);
  assert.equal(status.state.active.candidate, before.active.candidate);
  await server.shutdown();
  await startServer(new Receiver(receiver.config));
  const restored = await fetch(`${base}/api/status`).then((response) => response.json());
  assert.equal(restored.operation.error.code, 'LEDGER_WRITE_FAILED');
  assert.equal(restored.state.active.prUrl, url);
  denied = false;
  attempts = 0;
  const success = await withdraw('b'.repeat(32));
  assert.equal(success.status, 'SUCCEEDED');
  assert.equal(attempts, 3);
  const after = await receiver.status();
  assert.equal(after.active.prUrl, undefined);
  assert.equal(after.active.candidate, before.active.candidate);
  assert.equal(after.active.prHistory.length, 1, 'file retries must not repeat the withdrawal');
  assert.deepEqual(after.accepted, before.accepted);
  assert.equal(await receiver.git.remoteBranch(after.active.branch), before.active.candidate);
});

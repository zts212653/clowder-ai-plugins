import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiverServer } from '../src/server.mjs';

test('long operation returns 202, reports stages and rejects duplicate concurrent operations', async () => {
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  const receiver = {
    config: { mode: 'version' },
    status: async () => null,
    store: { locked: (operation) => operation() },
    git: {
      heads: async () => {
        await gate;
        return { upstream: 'a'.repeat(40), internal: 'b'.repeat(40) };
      },
    },
  };
  const server = createReceiverServer(receiver);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bootstrap = await (await fetch(`${base}/api/status`)).json();
    const headers = { 'X-Repo-Sync-Token': bootstrap.token };
    assert.equal((await fetch(`${base}/api/tasks/${'a'.repeat(32)}`)).status, 403);
    assert.equal(
      (
        await fetch(`${base}/api/tasks`, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://foreign.example' },
          body: '{}',
        })
      ).status,
      403,
    );
    const post = (id) =>
      fetch(`${base}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ action: 'heads', requestId: id }) });
    const first = await post('a'.repeat(32));
    assert.equal(first.status, 202);
    const task = (await first.json()).operation;
    assert.equal(task.status, 'RUNNING');
    assert.equal((await post('a'.repeat(32))).status, 202, 'same request resumes the original operation');
    assert.equal((await post('b'.repeat(32))).status, 409);
    assert.equal(
      (await fetch(`${base}/api/action`, { method: 'POST', headers, body: '{"action":"prepare"}' })).status,
      409,
    );
    const visible = await (await fetch(`${base}/api/tasks/${task.id}`, { headers })).json();
    assert.equal(visible.operation.status, 'RUNNING');
    release();
    let final;
    for (let i = 0; i < 100; i++) {
      final = (await (await fetch(`${base}/api/tasks/${task.id}`, { headers })).json()).operation;
      if (final.status !== 'RUNNING') break;
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.equal(final.status, 'SUCCEEDED');
    assert.equal(final.result.internal, 'b'.repeat(40));
  } finally {
    release();
    await new Promise((done) => server.close(done));
  }
});

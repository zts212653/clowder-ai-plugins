import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { phase } from '../src/execution.mjs';
import { command } from '../src/process.mjs';
import { Tasks } from '../src/tasks.mjs';

async function settled(tasks) {
  await tasks.job;
  return tasks.latest();
}
test('task records preserve stages and safe diagnostics across a new server, without raw output', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'repo-sync-task-recovery-'));
  const receiver = { config: { stateDir: folder, bindingId: 'fixture-binding' }, status: async () => null };
  const tasks = new Tasks(
    async () => receiver,
    async () => {
      await phase('source-probe', '检查外部连接与分支', async () => null);
      await phase('internal-probe', '检查内部连接与分支', () =>
        command(process.execPath, [
          '-e',
          'process.stderr.write("Host key verification failed. private-host fixture-token\\n");process.exit(128)',
        ]),
      );
    },
  );
  await tasks.start({ action: 'heads', requestId: 'c'.repeat(32), expectedBinding: receiver.config.bindingId });
  const result = await settled(tasks);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.steps[0].status, 'DONE');
  assert.equal(result.steps[1].status, 'FAILED');
  assert.equal(result.error.code, 'SSH_HOST_KEY_FAILED');
  const text = await readFile(join(folder, 'operations', `${result.id}.json`), 'utf8');
  assert.doesNotMatch(text, /private-host|fixture-token|stderr|stack/);
  const reloaded = new Tasks(
    async () => receiver,
    async () => assert.fail('must not execute while reading old task'),
  );
  assert.deepEqual(await reloaded.latest(), { ...result, cancellable: false });
});
test('cancelled download records cancellation and never continues to baseline registration', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'repo-sync-task-cancel-'));
  const receiver = { config: { stateDir: folder, bindingId: 'cancel-binding' } };
  let registered = false;
  const tasks = new Tasks(
    async () => receiver,
    async () => {
      await phase('source-fetch', '下载外部对象', () =>
        command(process.execPath, [
          '-e',
          'process.stderr.write("Receiving objects: 40% (2/5)\\r");setInterval(()=>{},1000)',
        ]),
      );
      await phase(
        'baseline-save',
        '登记已有基线',
        async () => {
          registered = true;
        },
        false,
      );
    },
  );
  const first = await tasks.start({
    action: 'adopt',
    requestId: 'd'.repeat(32),
    expectedBinding: receiver.config.bindingId,
  });
  try {
    for (let i = 0; i < 200; i++) {
      if ((await tasks.latest()).steps.some((step) => step.progress)) break;
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.ok((await tasks.latest()).steps.some((step) => step.progress?.percent === 40));
    assert.equal((await tasks.cancel(first.id)).status, 'CANCELLING');
    const result = await settled(tasks);
    assert.equal(result.status, 'CANCELLED');
    assert.equal(result.steps.filter((step) => step.status === 'FAILED').length, 1, 'later steps stay pending');
    assert.equal(registered, false);
  } finally {
    if (tasks.busy() && tasks.context?.cancellable) await tasks.cancel(first.id).catch(() => {});
    await tasks.job;
  }
});
test('task status and cancellation do not widen MCP data or allow changed request parameters', async () => {
  const receiver = { config: {} };
  const tasks = new Tasks(
    async () => receiver,
    async () => null,
  );
  const input = { action: 'heads', requestId: 'e'.repeat(32) };
  await tasks.start(input);
  await tasks.job;
  await assert.rejects(tasks.start({ ...input, action: 'tags' }), { code: 'REQUEST_CHANGED' });
  await assert.rejects(tasks.start({ ...input, requestId: 'f'.repeat(32), checks: [] }), {
    code: 'INVALID_TASK_INPUT',
  });
});

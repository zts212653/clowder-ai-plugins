import assert from 'node:assert/strict';
import test from 'node:test';
import { phase } from '../src/execution.mjs';
import { command } from '../src/process.mjs';
import { Tasks } from '../src/tasks.mjs';

test('candidate preparation can stop before publication, while publication remains protected', async () => {
  const receiver = { config: {} };
  let published = false;
  const before = new Tasks(
    async () => receiver,
    async () => {
      await phase('candidate-check', '执行配置的项目检查', () =>
        command(process.execPath, [
          '-e',
          'process.stderr.write("Receiving objects: 20% (1/5)\\r");setInterval(()=>{},1000)',
        ]),
      );
      await phase(
        'candidate-publish',
        '推送并回读候选分支',
        async () => {
          published = true;
        },
        false,
      );
    },
  );
  const first = await before.start({ action: 'prepare', requestId: '1'.repeat(32) });
  for (let i = 0; i < 200; i++) {
    if ((await before.latest()).steps.some((step) => step.progress)) break;
    await new Promise((done) => setTimeout(done, 10));
  }
  try {
    assert.equal((await before.latest()).cancellable, true);
    await before.cancel(first.id);
  } finally {
    before.controller.abort();
    await before.job;
  }
  assert.equal((await before.latest()).status, 'CANCELLED');
  assert.equal(published, false);
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  const publishing = new Tasks(
    async () => receiver,
    () => phase('candidate-publish', '推送并回读候选分支', () => gate, false),
  );
  const second = await publishing.start({ action: 'prepare', requestId: '2'.repeat(32) });
  try {
    assert.equal((await publishing.latest()).cancellable, false);
    await assert.rejects(publishing.cancel(second.id), { code: 'CANCEL_NOT_ALLOWED' });
  } finally {
    release();
    await publishing.job;
  }
});

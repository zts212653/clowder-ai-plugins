import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { phase } from '../src/execution.mjs';
import { Tasks } from '../src/tasks.mjs';

async function fixture(perform) {
  const folder = await fs.mkdtemp(join(tmpdir(), 'repo-sync-task-durability-'));
  const receiver = { config: { stateDir: folder, bindingId: 'durability-binding' } };
  const resolve = async () => receiver;
  return { tasks: new Tasks(resolve, perform), resolve, folder, receiver };
}
test('one failed progress save does not prevent a later terminal record or replay business', async (t) => {
  let calls = 0;
  let armed = false;
  const f = await fixture(async () => {
    calls++;
    armed = true;
    await phase('source-probe', '检查连接', async () => null);
  });
  const rename = fs.rename;
  let failures = 0;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (armed && to.endsWith(`${'a'.repeat(32)}.json`) && failures++ < 7)
      throw Object.assign(new Error('private source'), { code: 'EPERM' });
    return rename(from, to);
  });
  await f.tasks.start({ action: 'heads', requestId: 'a'.repeat(32), expectedBinding: f.receiver.config.bindingId });
  await f.tasks.job;
  assert.equal((await f.tasks.latest()).status, 'SUCCEEDED');
  assert.equal((await new Tasks(f.resolve, () => assert.fail('must not replay')).latest()).status, 'SUCCEEDED');
  assert.equal(calls, 1);
});
test('failed latest pointer registration leaves a terminal nonexecuted request instead of a live orphan', async (t) => {
  let calls = 0;
  const f = await fixture(async () => calls++);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to.endsWith('latest.json')) throw Object.assign(new Error('occupied'), { code: 'EPERM' });
    return rename(from, to);
  });
  const input = { action: 'heads', requestId: 'b'.repeat(32), expectedBinding: f.receiver.config.bindingId };
  await assert.rejects(() => f.tasks.start(input), { code: 'TASK_STORE_FAILED' });
  assert.equal((await f.tasks.latest(input.requestId)).status, 'FAILED');
  assert.equal((await new Tasks(f.resolve, () => assert.fail()).latest(input.requestId)).status, 'FAILED');
  assert.equal(calls, 0);
});
test('failed audit persistence never degrades an unconfirmed process stop into an ordinary failure', async (t) => {
  let armed = false;
  const f = await fixture(async () => {
    armed = true;
    throw Object.assign(new Error('cannot confirm stop'), { code: 'STOP_UNCONFIRMED', safeToDisplay: true });
  });
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (armed) throw Object.assign(new Error('occupied'), { code: 'EPERM' });
    return rename(from, to);
  });
  await f.tasks.start({ action: 'heads', requestId: 'c'.repeat(32), expectedBinding: f.receiver.config.bindingId });
  await f.tasks.job;
  assert.equal((await f.tasks.latest()).status, 'STOP_UNCONFIRMED');
  assert.equal(f.tasks.busy(), true);
});

test('repairing a final record never repeats completed business and unblocks only after saving', async (t) => {
  let calls = 0;
  let occupied = false;
  const f = await fixture(async () => {
    calls++;
    occupied = true;
  });
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (occupied) throw Object.assign(new Error('occupied'), { code: 'EPERM' });
    return rename(from, to);
  });
  const id = 'd'.repeat(32);
  await f.tasks.start({ action: 'heads', requestId: id, expectedBinding: f.receiver.config.bindingId });
  await f.tasks.job;
  assert.equal(f.tasks.busy(), true);
  assert.equal((await f.tasks.latest()).persistence.canRetry, true);
  await assert.rejects(
    () => f.tasks.start({ action: 'heads', requestId: 'e'.repeat(32), expectedBinding: f.receiver.config.bindingId }),
    { code: 'OPERATION_RUNNING' },
  );
  occupied = false;
  await f.tasks.retryPersistence(id);
  assert.equal(calls, 1);
  assert.equal(f.tasks.busy(), false);
  assert.equal((await new Tasks(f.resolve, () => assert.fail()).latest()).status, 'SUCCEEDED');
});

test('two workbench instances cannot admit two business jobs for the same binding simultaneously', async () => {
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  let calls = 0;
  const perform = async () => {
    calls++;
    await gate;
  };
  const f = await fixture(perform);
  const other = new Tasks(f.resolve, perform);
  try {
    const results = await Promise.allSettled([
      f.tasks.start({ action: 'heads', requestId: 'e'.repeat(32), expectedBinding: f.receiver.config.bindingId }),
      other.start({ action: 'heads', requestId: 'f'.repeat(32), expectedBinding: f.receiver.config.bindingId }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(calls, 1);
  } finally {
    release();
    await f.tasks.job;
    await other.job;
  }
});

test('shutdown waits when a task becomes non-cancellable at the cancellation boundary', async () => {
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  const f = await fixture(async () => gate);
  try {
    await f.tasks.start({ action: 'heads', requestId: '9'.repeat(32), expectedBinding: f.receiver.config.bindingId });
    const cancel = f.tasks.cancel.bind(f.tasks);
    f.tasks.cancel = async (id) => {
      f.tasks.context.cancellable = false;
      return cancel(id);
    };
    const closing = f.tasks.close();
    release();
    await assert.doesNotReject(closing);
    assert.equal((await f.tasks.latest()).status, 'SUCCEEDED');
  } finally {
    release();
    await f.tasks.job;
  }
});

test('terminal business stays visibly running until its final execution record is saved', async (t) => {
  let release;
  let started;
  const reached = new Promise((done) => {
    started = done;
  });
  const gate = new Promise((done) => {
    release = done;
  });
  const f = await fixture(async () => null);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to.endsWith(`${'a'.repeat(32)}.json`) && JSON.parse(await fs.readFile(from, 'utf8')).status === 'SUCCEEDED') {
      started();
      await gate;
    }
    return rename(from, to);
  });
  try {
    await f.tasks.start({ action: 'heads', requestId: 'a'.repeat(32), expectedBinding: f.receiver.config.bindingId });
    await reached;
    assert.equal((await f.tasks.latest()).status, 'RUNNING');
    assert.equal((await f.tasks.latest()).steps.at(-1).label, '保存执行记录');
    assert.equal(f.tasks.busy(), true);
  } finally {
    release();
    await f.tasks.job;
  }
  assert.equal((await f.tasks.latest()).status, 'SUCCEEDED');
});

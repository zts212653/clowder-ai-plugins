import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readTask } from '../src/task-store.mjs';

test('unknown status or missing owner cannot be interpreted as a finished or interrupted task', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'repo-sync-task-validation-'));
  const config = { stateDir: folder, bindingId: 'validation-binding' };
  await mkdir(join(folder, 'operations'));
  const id = 'a'.repeat(32);
  const file = join(folder, 'operations', `${id}.json`);
  for (const value of [
    { id, bindingId: config.bindingId, status: 'UNKNOWN', ownerPid: process.pid, steps: [] },
    { id, bindingId: config.bindingId, status: 'RUNNING', steps: [] },
  ]) {
    const text = JSON.stringify(value);
    await writeFile(file, text);
    await assert.rejects(() => readTask(config, id), { code: 'TASK_UNREADABLE' });
    assert.equal(await readFile(file, 'utf8'), text);
  }
});
test('latest pointer to a missing record is corruption, not an empty task history', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'repo-sync-task-pointer-'));
  await mkdir(join(folder, 'operations'));
  await writeFile(join(folder, 'operations', 'latest.json'), JSON.stringify({ id: 'b'.repeat(32) }));
  await assert.rejects(() => readTask({ stateDir: folder, bindingId: 'fixture-binding' }), { code: 'TASK_UNREADABLE' });
});

test('a request ID belonging to a different binding cannot be treated as an unused ID', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'repo-sync-task-foreign-'));
  await mkdir(join(folder, 'operations'));
  const id = 'c'.repeat(32);
  await writeFile(join(folder, 'operations', `${id}.json`), JSON.stringify({ id, bindingId: 'other-binding' }));
  await assert.rejects(() => readTask({ stateDir: folder, bindingId: 'current-binding' }, id), {
    code: 'TASK_BINDING_CHANGED',
  });
});

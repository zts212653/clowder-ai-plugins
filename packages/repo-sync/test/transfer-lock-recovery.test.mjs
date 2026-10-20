import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recoverRegistrationLock } from '../src/transfer-lock-recovery.mjs';

async function fixture(content) {
  const directory = await mkdtemp(join(tmpdir(), 'repo-sync-lock-recovery-'));
  const file = join(directory, 'config.json.projects.json');
  await writeFile(file, '{"schema":1,"projects":[]}');
  await writeFile(join(directory, 'ledger.json'), 'PERSISTENT_HISTORY_MUST_REMAIN');
  if (content !== undefined) await writeFile(`${file}.lock`, content);
  return { directory, file, lock: `${file}.lock` };
}
const confirm = { confirmWritersStopped: true };

test('registration lock recovery requires explicit confirmation even when the lock is absent', async () => {
  const f = await fixture();
  for (const options of [undefined, null, {}, { confirmWritersStopped: false }, { confirmWritersStopped: 'true' }])
    await assert.rejects(recoverRegistrationLock(f.file, options), { code: 'CONFIGURATION_WRITERS_NOT_CONFIRMED' });
});

test('missing lock recovery is idempotent and does not remove project configuration or history', async () => {
  const f = await fixture();
  assert.deepEqual(await recoverRegistrationLock(f.file, confirm), { recovered: false });
  assert.equal(await readFile(f.file, 'utf8'), '{"schema":1,"projects":[]}');
  assert.equal(await readFile(join(f.directory, 'ledger.json'), 'utf8'), 'PERSISTENT_HISTORY_MUST_REMAIN');
});

test('a lock owned by the current live process is never released', async () => {
  const original = JSON.stringify({ pid: process.pid });
  const f = await fixture(original);
  await assert.rejects(recoverRegistrationLock(f.file, confirm), { code: 'CONFIGURATION_WRITER_ALIVE' });
  assert.equal(await readFile(f.lock, 'utf8'), original);
});

test('a genuinely exited child allows release, and repeat recovery does not touch persistent data', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
  const pid = child.pid;
  await once(child, 'close');
  assert.ok(Number.isInteger(pid) && pid > 0);
  const f = await fixture(JSON.stringify({ pid }));
  assert.deepEqual(await recoverRegistrationLock(f.file, confirm), { recovered: true });
  await assert.rejects(lstat(f.lock), { code: 'ENOENT' });
  assert.deepEqual(await recoverRegistrationLock(f.file, confirm), { recovered: false });
  assert.equal(await readFile(f.file, 'utf8'), '{"schema":1,"projects":[]}');
  assert.equal(await readFile(join(f.directory, 'ledger.json'), 'utf8'), 'PERSISTENT_HISTORY_MUST_REMAIN');
});

test('corrupt or invalid lock ownership is preserved instead of guessed', async () => {
  for (const original of [
    'PRIVATE_RAW_SECRET',
    'null',
    '[]',
    '{}',
    '{"pid":0}',
    '{"pid":-1}',
    '{"pid":"7"}',
    '{"pid":1.2}',
  ]) {
    const f = await fixture(original);
    await assert.rejects(recoverRegistrationLock(f.file, confirm), (error) => {
      assert.equal(error.code, 'CONFIGURATION_LOCK_INVALID');
      assert.equal(error.safeToDisplay, true);
      assert.doesNotMatch(error.message, /PRIVATE_RAW_SECRET|repo-sync-lock-recovery-/);
      return true;
    });
    assert.equal(await readFile(f.lock, 'utf8'), original);
  }
});

test('a permission error probing the owner is treated as alive', async (t) => {
  const f = await fixture('{"pid":123}');
  t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('PRIVATE_RAW_SECRET'), { code: 'EPERM' });
  });
  await assert.rejects(recoverRegistrationLock(f.file, confirm), { code: 'CONFIGURATION_WRITER_ALIVE' });
  assert.equal(await readFile(f.lock, 'utf8'), '{"pid":123}');
});

test('a changed lock between ownership probe and release is not removed', async (t) => {
  const f = await fixture('{"pid":123}');
  const replacement = JSON.stringify({ pid: process.pid });
  t.mock.method(process, 'kill', () => {
    writeFileSync(f.lock, replacement);
    throw Object.assign(new Error('exited owner'), { code: 'ESRCH' });
  });
  await assert.rejects(recoverRegistrationLock(f.file, confirm), { code: 'LOCK_OWNER_CHANGED' });
  assert.equal(await readFile(f.lock, 'utf8'), replacement);
});

test('only a private absolute configuration path can be recovered', async () => {
  await assert.rejects(recoverRegistrationLock('relative-config.json', confirm), { code: 'PRIVATE_CONFIG_PATH' });
});

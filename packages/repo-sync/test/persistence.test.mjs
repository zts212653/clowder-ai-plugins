import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { safeError } from '../src/execution.mjs';
import { writePrivate } from '../src/private-config.mjs';
import { Store } from '../src/store.mjs';

function mockIo(t, name, action) {
  t.mock.method(fs, name, action);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}
async function stored() {
  const folder = await fs.mkdtemp(join(tmpdir(), 'repo-sync-persistence-'));
  const store = new Store(folder);
  await store.save({ revision: 0 });
  return store;
}
test('transient rename sharing errors retry the file replacement, not business execution', async (t) => {
  const store = await stored();
  const rename = fs.rename;
  let attempts = 0;
  mockIo(t, 'rename', async (from, to) => {
    if (to === store.path && attempts++ < 3)
      throw Object.assign(new Error('private path must never be displayed'), { code: 'EPERM' });
    return rename(from, to);
  });
  await store.save({ revision: 1 });
  assert.equal(attempts, 4);
  assert.deepEqual(await store.read(), { revision: 1 });
});

test('permanent write failure is typed, keeps the original ledger and removes only its temporary file', async (t) => {
  const store = await stored();
  mockIo(t, 'rename', async () => {
    throw Object.assign(new Error('private path and original platform text'), { code: 'EPERM' });
  });
  await assert.rejects(
    () => store.save({ revision: 1 }),
    (error) => {
      assert.equal(safeError(error).code, 'LEDGER_WRITE_FAILED');
      assert.doesNotMatch(JSON.stringify(safeError(error)), /private path|platform text/);
      return true;
    },
  );
  assert.deepEqual(await store.read(), { revision: 0 });
  assert.deepEqual(await fs.readdir(store.directory), ['ledger.json']);
});

test('status reads and replacements of the same path are coordinated across Store instances', async (t) => {
  const store = await stored();
  const other = new Store(store.directory);
  const readFile = fs.readFile;
  const rename = fs.rename;
  let readers = 0;
  let collisions = 0;
  mockIo(t, 'readFile', async (file, ...args) => {
    if (file !== store.path) return readFile(file, ...args);
    readers++;
    try {
      await delay(20);
      return await readFile(file, ...args);
    } finally {
      readers--;
    }
  });
  mockIo(t, 'rename', async (from, to) => {
    if (to === store.path && readers) {
      collisions++;
      throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
    }
    return rename(from, to);
  });
  const reads = Array.from({ length: 12 }, () => other.read());
  await store.save({ revision: 1 });
  for (const state of await Promise.all(reads)) assert.equal(state.revision, 0);
  assert.equal(collisions, 0);
  assert.deepEqual(await store.read(), { revision: 1 });
});

test('private configuration uses the same safe atomic replacement policy', async (t) => {
  const store = await stored();
  const file = join(store.directory, 'config.json');
  await writePrivate(file, { revision: 0 });
  const rename = fs.rename;
  let attempts = 0;
  mockIo(t, 'rename', async (from, to) => {
    if (to === file && attempts++ < 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return rename(from, to);
  });
  await writePrivate(file, { revision: 1 });
  assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { revision: 1 });
});

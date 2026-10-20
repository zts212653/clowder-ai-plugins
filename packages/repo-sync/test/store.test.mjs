import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Store } from '../src/store.mjs';

test('writer lock prevents concurrent execution and never takes over a live writer', async () => {
  const directory = join(process.cwd(), '.cat-cafe', 'tmp');
  await mkdir(directory, { recursive: true });
  const store = new Store(await mkdtemp(join(directory, 'repo-sync-store-')));
  await store.locked(async () => {
    await assert.rejects(() => store.locked(() => store.save({})), { code: 'WRITER_LOCKED' });
    await assert.rejects(() => store.unlock(), { code: 'WRITERS_NOT_CONFIRMED' });
    await assert.rejects(() => store.unlock(true), { code: 'WRITER_STILL_ALIVE' });
    await store.save({ saved: true });
  });
  assert.deepEqual(await store.read(), { saved: true });
  await writeFile(store.path, 'broken');
  await assert.rejects(() => store.read(), { code: 'LEDGER_UNREADABLE' });
  assert.equal(await readFile(store.path, 'utf8'), 'broken');
});

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Receiver } from '../src/engine.mjs';
import { git } from '../src/process.mjs';
import { versionRepositories } from './version-fixtures.mjs';

test('version: declared internal binary file is preserved by exact blob while the upstream core is received', async () => {
  const f = await versionRepositories();
  await writeFile(join(f.source, 'README.md'), Buffer.from([1, 0, 2]));
  await git(f.source, ['add', '.']);
  await git(f.source, ['commit', '-m', 'synthetic binary target']);
  await git(f.source, ['tag', 'v3.0.0']);
  await writeFile(join(f.review, 'README.md'), Buffer.from([3, 0, 4]));
  await git(f.review, ['add', '.']);
  await git(f.review, ['commit', '-m', 'synthetic binary local']);
  await git(f.review, ['push', 'origin', 'main']);
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, await git(f.review, ['rev-parse', 'HEAD']));
  await receiver.selectTag('v3.0.0');
  await receiver.start();
  await receiver.prepare();
  const delivery = (await receiver.status()).active;
  assert.equal(
    await git(receiver.git.directory, ['rev-parse', `${delivery.candidate}:README.md`]),
    await git(f.review, ['rev-parse', 'HEAD:README.md']),
  );
  assert.equal(await git(receiver.git.directory, ['show', `${delivery.candidate}:core.txt`]), 'release two');
});
test('version: tag change during checks blocks publication of a previously built candidate', async () => {
  const f = await versionRepositories();
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.selectTag('v2.0.0');
  await receiver.start();
  const original = receiver.git.checks.bind(receiver.git);
  receiver.git.checks = async (head) => {
    const result = await original(head);
    await git(f.source, ['tag', '-f', 'v2.0.0', f.u0]);
    return result;
  };
  await assert.rejects(() => receiver.prepare(), { code: 'TAG_MOVED' });
  const delivery = (await receiver.status()).active;
  assert.ok(delivery.candidate);
  assert.equal(await receiver.git.remoteBranch(delivery.branch), null);
});
test('version: remote push with missing receipt recovers the same published branch', async () => {
  const f = await versionRepositories();
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.selectTag('v2.0.0');
  await receiver.start();
  await receiver.prepare();
  const ledger = await receiver.read();
  ledger.deliveries[0].status = 'PUSH_RESULT_UNKNOWN';
  await receiver.store.save(ledger);
  await new Receiver(f.config).recover();
  const delivery = (await receiver.status()).active;
  assert.equal(delivery.status, 'PR_REQUIRED');
  assert.equal(await receiver.git.remoteBranch(delivery.branch), delivery.candidate);
});

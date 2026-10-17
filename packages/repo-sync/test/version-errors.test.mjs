import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Receiver } from '../src/engine.mjs';
import { git } from '../src/process.mjs';
import { versionRepositories } from './version-fixtures.mjs';

async function pushChange(f, directory, file, content) {
  await writeFile(join(directory, file), content);
  await git(directory, ['add', '.']);
  await git(directory, ['commit', '-m', 'synthetic change']);
  if (directory === f.review) await git(directory, ['push', 'origin', 'main']);
  return git(directory, ['rev-parse', 'HEAD']);
}
test('version: divergent preserved text is retained whole across restart, without file merging or resolution APIs', async () => {
  const f = await versionRepositories();
  const i0 = await pushChange(f, f.review, 'README.md', '内部新版介绍\n\n运行说明\n\n内部联系说明\n');
  let receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, i0);
  await receiver.selectTag('v2.0.0');
  await receiver.start();
  await receiver.prepare();
  const prepared = (await receiver.status()).active;
  receiver = new Receiver(f.config);
  const active = (await receiver.status()).active;
  assert.equal(active.id, prepared.id);
  assert.equal(
    await git(receiver.git.directory, ['show', `${active.candidate}:README.md`]),
    '内部新版介绍\n\n运行说明\n\n内部联系说明',
  );
  assert.equal(receiver.resolve, undefined);
  assert.equal(receiver.conflict, undefined);
  assert.equal(await receiver.git.remoteBranch(active.branch), active.candidate);
});
test('version: moved tag blocks publication and an unpublished delivery can be cancelled without erasing audit', async () => {
  const f = await versionRepositories();
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.selectTag('v2.0.0');
  await receiver.start();
  await git(f.source, ['tag', '-f', 'v2.0.0', f.u0]);
  await assert.rejects(() => receiver.prepare(), { code: 'TAG_MOVED' });
  const first = (await receiver.status()).active;
  assert.equal(await receiver.git.remoteBranch(first.branch), null);
  await receiver.cancelVersion();
  assert.equal((await receiver.status()).deliveries[0].status, 'CANCELLED');
  await git(f.source, ['tag', '-f', 'v2.0.0', f.u1]);
  await receiver.selectTag('v2.0.0');
  await receiver.start();
  assert.notEqual((await receiver.status()).active.id, first.id);
  await receiver.prepare();
  await assert.rejects(() => receiver.cancelVersion(), { code: 'CANCEL_UNSAFE' });
});
test('version: a new upstream path colliding with internal-only directory is explicit and never pushed', async () => {
  const f = await versionRepositories();
  await mkdir(join(f.source, 'internal-docs'));
  const target = await pushChange(f, f.source, 'internal-docs/new.md', 'upstream collision');
  await git(f.source, ['tag', 'v3.0.0', target]);
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.selectTag('v3.0.0');
  await receiver.start();
  await assert.rejects(() => receiver.prepare(), { code: 'INTERNAL_PATH_COLLISION' });
  const state = await receiver.status();
  assert.deepEqual(state.active.error.details.paths, ['internal-docs/new.md']);
  assert.equal(await receiver.git.remoteBranch(state.active.branch), null);
});
test('version: allowed internal follow-up commits are adopted; unexpected main change during delivery pauses', async () => {
  const f = await versionRepositories();
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  const actual = await pushChange(f, f.review, 'internal-docs/guide.md', 'customization two');
  await receiver.selectTag('v2.0.0');
  assert.equal((await receiver.status()).accepted.internal, actual);
  await receiver.start();
  await pushChange(f, f.review, 'internal-docs/guide.md', 'customization three');
  await assert.rejects(() => receiver.prepare(), { code: 'RECOVERY_FIRST' });
  await assert.rejects(() => receiver.recover(), { code: 'MERGE_UNATTRIBUTABLE' });
  assert.equal((await receiver.status()).accepted.internal, actual);
});
test('version: checks fail before publishing and modified merge results never advance the cursor', async () => {
  const f = await versionRepositories();
  const broken = new Receiver({
    ...f.config,
    checks: [{ command: process.execPath, args: ['-e', 'process.exit(1)'] }],
  });
  await broken.adopt(f.u0, f.i0);
  await broken.selectTag('v2.0.0');
  await broken.start();
  await assert.rejects(() => broken.prepare(), { code: 'COMMAND_FAILED' });
  assert.equal(await broken.git.remoteBranch((await broken.status()).active.branch), null);
  const receiver = new Receiver(f.config);
  await receiver.prepare();
  await receiver.linkPr('https://codehub.example/core/pull/500');
  const active = (await receiver.status()).active;
  const modifiedTree = await receiver.git.tree(f.i0);
  const bad = await receiver.git.mergeNode(modifiedTree, [f.i0, active.candidate], 'incorrect platform result');
  await git(receiver.git.directory, ['push', f.internal, `${bad}:refs/heads/main`]);
  await assert.rejects(() => receiver.recover(), { code: 'TREE_MISMATCH' });
  assert.equal((await receiver.status()).accepted.upstream, f.u0);
});

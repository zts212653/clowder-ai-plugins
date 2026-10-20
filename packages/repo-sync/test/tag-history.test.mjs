import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Receiver } from '../src/engine.mjs';
import { ancestor, git } from '../src/process.mjs';
import { sourceTarget } from '../src/source-target.mjs';
import { versionRepositories } from './version-fixtures.mjs';

async function releaseOutsideBranch() {
  const f = await versionRepositories();
  // Release tags advance from U0, while the configured branch has a different continuation.
  await git(f.source, ['switch', '-c', 'branch-delivery', f.u0]);
  await writeFile(join(f.source, 'core.txt'), 'branch-only continuation');
  await git(f.source, ['add', '.']);
  await git(f.source, ['commit', '-m', 'independent source branch continuation']);
  f.config.sourceBranch = 'branch-delivery';
  return f;
}

test('version: a forward release tag outside source branch completes and preserves internal files', async () => {
  const f = await releaseOutsideBranch();
  let receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  const heads = await receiver.git.fetch();
  assert.equal(await ancestor(f.source, f.u0, f.u1), true);
  assert.equal(await ancestor(f.source, f.u1, heads.upstream), false);
  await receiver.selectTag('v2.0.0');
  await receiver.start();
  receiver = new Receiver(f.config);
  await receiver.prepare();
  const active = (await receiver.status()).active;
  assert.equal(await git(receiver.git.directory, ['show', `${active.candidate}:core.txt`]), 'release two');
  assert.equal(
    await git(receiver.git.directory, ['rev-parse', `${active.candidate}:README.md`]),
    await git(f.review, ['rev-parse', 'HEAD:README.md']),
  );
  await receiver.linkPr('https://codehub.example/core/pull/501');
  await f.merge(active);
  await new Receiver(f.config).recover();
  const state = await receiver.status();
  assert.equal(state.accepted.upstream, f.u1);
  assert.equal(state.accepted.tag, 'v2.0.0');
  assert.equal(state.deliveries[0].status, 'COMPLETE');
  assert.deepEqual(state.issues, {});
  await assert.rejects(() => receiver.selectTag('v1.0.0'), { code: 'VERSION_NOT_FORWARD' });
});

test('version: adoption reads a published release tag absent from the source branch object fetch', async () => {
  const f = await releaseOutsideBranch();
  const first = new Receiver(f.config);
  await first.adopt(f.u0, f.i0);
  await first.git.fetch();
  await first.git.baseline(f.u0, f.i0);
  // Independent internal snapshot already contains the release core and its retained README.
  await writeFile(join(f.review, 'core.txt'), 'release two');
  await git(f.review, ['add', '.']);
  await git(f.review, ['commit', '-m', 'preexisting release snapshot']);
  await git(f.review, ['push', 'origin', 'main']);
  const receiver = new Receiver({ ...f.config, stateDir: join(f.root, 'fresh-tag-baseline') });
  await receiver.adopt(f.u1, await git(f.review, ['rev-parse', 'HEAD']));
  assert.equal((await receiver.status()).accepted.upstream, f.u1);
  await assert.rejects(() => receiver.selectTag('v2.0.0'), { code: 'NO_VERSION_UPDATE' });
});

test('process: off-branch target is identified precisely and does not change the accepted range', async () => {
  const f = await releaseOutsideBranch();
  const receiver = new Receiver({ ...f.config, mode: 'continuous' });
  await receiver.adopt(f.u0, f.i0);
  const state = await receiver.read(),
    heads = await receiver.git.fetch();
  const before = await readFile(receiver.store.path, 'utf8');
  await assert.rejects(
    () => sourceTarget(receiver, state, heads, { kind: 'tag', value: 'v2.0.0' }),
    (error) => {
      assert.equal(error.code, 'TARGET_NOT_ON_SOURCE_BRANCH');
      assert.match(error.message, /按版本更新/);
      assert.match(error.message, new RegExp(f.u1.slice(0, 12)));
      return true;
    },
  );
  assert.equal(await readFile(receiver.store.path, 'utf8'), before);
  await assert.rejects(
    () => sourceTarget(receiver, { accepted: { upstream: f.u1 } }, heads, { kind: 'commit', value: f.u0 }),
    { code: 'TARGET_NOT_FORWARD' },
  );
});

test('version: a higher-named divergent tag cannot bypass ancestry or change the accepted baseline', async () => {
  const f = await versionRepositories();
  await git(f.source, ['switch', '-c', 'divergent-release', `${f.u0}^`]);
  await writeFile(join(f.source, 'core.txt'), 'unrelated release');
  await git(f.source, ['add', '.']);
  await git(f.source, ['commit', '-m', 'divergent tag with a newer name']);
  await git(f.source, ['tag', 'v99.0.0']);
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await assert.rejects(() => receiver.selectTag('v99.0.0'), { code: 'VERSION_NOT_FORWARD' });
  const state = await receiver.status();
  assert.equal(state.accepted.upstream, f.u0);
  assert.deepEqual(state.queue, []);
  assert.equal(state.active, undefined);
  assert.equal(await git(f.review, ['rev-parse', 'HEAD']), f.i0);
});

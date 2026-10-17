import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Receiver } from '../src/engine.mjs';
import { git } from '../src/process.mjs';
import { continuousRepositories } from './continuous-fixtures.mjs';

test('continuous retains README names and absence across two PRs while preserving source ancestry and strict core', async () => {
  const f = await continuousRepositories();
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue(f.plans);
  for (let index = 0; index < 2; index++) {
    await receiver.start();
    if (!index) await receiver.linkIssue('issue-71', '318', 'https://codehub.example/core/issues/318');
    await receiver.prepare();
    const delivery = (await receiver.status()).active;
    assert.equal(await git(receiver.git.directory, ['show', `${delivery.candidate}:README.md`]), '内部默认中文版');
    assert.equal(
      await git(receiver.git.directory, ['show', `${delivery.candidate}:README.en.md`]),
      'Internal English documentation',
    );
    assert.equal(await git(receiver.git.directory, ['ls-tree', '--name-only', delivery.candidate, 'README.cn.md']), '');
    assert.equal(
      await git(receiver.git.directory, ['show', `${delivery.candidate}:core.txt`]),
      index ? 'second' : 'first',
    );
    assert.equal(await receiver.git.isAncestor(delivery.target, delivery.candidate), true);
    await receiver.linkPr(`https://codehub.example/core/pull/${index + 1}`);
    await f.merge(delivery);
    await receiver.recover();
    await receiver.receipts([{ sourceId: 'issue-71', internalId: '318', state: index ? 'closed' : 'open' }]);
    assert.equal((await receiver.status()).accepted.upstream, delivery.target);
  }
  assert.equal((await receiver.status()).deliveries.length, 2);
});

test('declared documentation differences do not permit drift in core files or structural collisions', async () => {
  const f = await continuousRepositories();
  const receiver = new Receiver(f.config);
  await writeFile(join(f.review, 'core.txt'), 'unexpected internal core');
  await git(f.review, ['add', '.']);
  await git(f.review, ['commit', '-m', 'unapproved core change']);
  await git(f.review, ['push', 'origin', 'main']);
  const head = await git(f.review, ['rev-parse', 'HEAD']);
  await assert.rejects(() => receiver.adopt(f.u0, head), { code: 'BASELINE_MISMATCH' });
  assert.equal(await receiver.status(), null);
});

test('a documentation-only PR retains an explicit receiving history instead of silently skipping its source', async () => {
  const f = await continuousRepositories();
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await git(f.source, ['switch', '-c', 'docs-only', f.u0]);
  await writeFile(join(f.source, 'README.md'), 'new English only');
  await git(f.source, ['add', '.']);
  await git(f.source, ['commit', '-m', 'documentation only']);
  const target = await git(f.source, ['rev-parse', 'HEAD']);
  await git(f.source, ['branch', '-f', 'releases', target]);
  await receiver.setQueue([{ ...f.plans[0], target, issues: [] }]);
  await receiver.start();
  await receiver.prepare();
  const delivery = (await receiver.status()).active;
  assert.equal(await receiver.git.sameTree(delivery.candidate, f.i0), true);
  assert.equal(await receiver.git.isAncestor(target, delivery.candidate), true);
  await receiver.linkPr('https://codehub.example/core/pull/1');
  await f.merge(delivery);
  await receiver.recover();
  await receiver.receipts([]);
  assert.equal((await receiver.status()).accepted.upstream, target);
});

test('a core directory colliding with a preserved internal file stops before candidate publication', async () => {
  const f = await continuousRepositories();
  await git(f.source, ['rm', 'README.md']);
  await mkdir(join(f.source, 'README.md'));
  await writeFile(join(f.source, 'README.md', 'core.txt'), 'upstream core directory');
  await git(f.source, ['add', '.']);
  await git(f.source, ['commit', '-m', 'file directory collision']);
  const target = await git(f.source, ['rev-parse', 'HEAD']);
  const receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await receiver.setQueue([{ ...f.plans[0], target, issues: [] }]);
  await receiver.start();
  await assert.rejects(() => receiver.prepare(), { code: 'INTERNAL_PATH_COLLISION' });
  const state = await receiver.status();
  assert.equal(state.active.candidate, null);
  assert.equal(await receiver.git.remoteBranch(state.active.branch), null);
  assert.equal(state.accepted.internal, f.i0);
});

test('only declared internal follow-up changes may advance the internal baseline between PR deliveries', async () => {
  const f = await continuousRepositories(),
    receiver = new Receiver(f.config);
  await receiver.adopt(f.u0, f.i0);
  await writeFile(join(f.review, 'README.md'), 'new internal Chinese documentation');
  await git(f.review, ['add', '.']);
  await git(f.review, ['commit', '-m', 'allowed internal documentation']);
  await git(f.review, ['push', 'origin', 'main']);
  const head = await git(f.review, ['rev-parse', 'HEAD']);
  await receiver.setQueue(f.plans);
  assert.equal((await receiver.status()).accepted.internal, head);
  await receiver.start();
  await receiver.linkIssue('issue-71', '318', 'https://codehub.example/core/issues/318');
  await receiver.prepare();
  assert.equal(
    await git(receiver.git.directory, ['show', `${(await receiver.status()).active.candidate}:README.md`]),
    'new internal Chinese documentation',
  );
});

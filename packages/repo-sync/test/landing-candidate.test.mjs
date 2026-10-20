import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCandidate } from '../src/commit-policy.mjs';
import { Receiver } from '../src/engine.mjs';
import { discover } from '../src/github.mjs';
import { git } from '../src/process.mjs';
import { developmentFixture } from './development-history-fixture.mjs';

test('stale squash head receives the landing tree without losing development history across restart', async () => {
  const f = await developmentFixture(3, { staleMain: true });
  await discover(f.receiver, { kind: 'latest' }, f.provider);
  await f.receiver.start();
  await f.receiver.prepare();
  const d = (await f.receiver.status()).active;
  const directory = f.receiver.git.directory;
  assert.equal(await git(directory, ['show', `${f.head}:inherited.txt`]), 'old main inherited.txt');
  assert.equal(await git(directory, ['show', `${d.candidate}:inherited.txt`]), 'new accepted main');
  await f.receiver.git.baseline(f.target, d.candidate);
  const paths = (await git(directory, ['ls-tree', '-r', '--name-only', d.candidate])).split('\n');
  assert.ok(paths.includes('parallel.txt'));
  assert.ok(paths.includes('new-name.txt'));
  for (const path of ['removed.txt', 'renamed.txt', 'pr-delete.txt']) assert.ok(!paths.includes(path), path);
  assert.equal(await git(directory, ['show', `${d.candidate}:README.md`]), 'internal readme');
  assert.equal(await git(directory, ['rev-list', '--count', `${f.internalBase}..${d.candidate}`]), '3');
  assert.equal(d.developmentMappings.length, 3);
  assert.equal(d.commitMappings[0].source, f.target);
  assert.equal(d.developmentMappings.at(-1).source, f.head);
  assert.equal(d.developmentMappings.at(-1).internal, d.candidate);
  for (const mapping of d.developmentMappings) {
    const message = async (sha) => {
      const object = await git(directory, ['cat-file', 'commit', sha], { binary: true });
      return object.subarray(object.indexOf(Buffer.from('\n\n')) + 2);
    };
    assert.deepEqual(await message(mapping.internal), await message(mapping.source));
  }
  assert.equal(await git(directory, ['show', `${d.developmentMappings[0].internal}:core.txt`]), 'feature 0');
  assert.equal(await git(directory, ['show', `${d.developmentMappings[1].internal}:core.txt`]), 'feature 0');
  assert.equal((await buildCandidate(f.receiver, await f.receiver.status(), d)).head, d.candidate);
  await f.receiver.linkPr('https://internal.example/core/merge_requests/1526');
  await f.merge(d);
  const restarted = new Receiver(f.config);
  restarted.git.config = { ...restarted.config, sourceUrl: f.source };
  await restarted.recover();
  await restarted.receipts([]);
  const completed = await restarted.status();
  assert.equal(completed.accepted.upstream, f.target);
  assert.equal(completed.deliveries[0].status, 'COMPLETE');
  assert.deepEqual(completed.deliveries[0].developmentMappings, d.developmentMappings);
});

test('rename similarity cannot hide a PR deletion during landing projection checks', async () => {
  const f = await developmentFixture(3, { staleMain: true, sharedContents: true });
  await discover(f.receiver, { kind: 'latest' }, f.provider);
  assert.equal((await f.receiver.status()).queue.length, 1);
});

test('a previously frozen stale-head candidate is not republished or silently rewritten', async () => {
  const f = await developmentFixture(3, { staleMain: true });
  await discover(f.receiver, { kind: 'latest' }, f.provider);
  await f.receiver.start();
  const state = await f.receiver.read(), d = f.receiver.active(state);
  const result = await buildCandidate(f.receiver, state, d);
  const tree = await f.receiver.git.tree(f.head);
  const stale = await f.receiver.git.mergeNode(tree, [f.internalBase], 'old frozen candidate');
  d.candidate = stale;
  d.commitMappings = result.mappings.map((item) => ({ ...item, internal: stale }));
  d.developmentMappings = result.developmentMappings.map((item) =>
    item.source === f.head ? { ...item, internal: stale } : item);
  await f.receiver.store.save(state);
  await assert.rejects(() => f.receiver.prepare(), { code: 'CANDIDATE_TREE_MISMATCH' });
  const stopped = await f.receiver.status();
  assert.equal(stopped.active.candidate, stale);
  assert.equal(stopped.accepted.upstream, f.u2);
  assert.equal(await f.receiver.git.remoteBranch(d.branch), null);
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { buildCandidate } from '../src/commit-policy.mjs';
import { Receiver } from '../src/engine.mjs';
import { discover } from '../src/github.mjs';
import { mappedCommit } from '../src/commit-policy.mjs';
import { git } from '../src/process.mjs';
import { requiredCommits } from '../src/transfer-objects.mjs';
import { developmentFixture } from './development-history-fixture.mjs';
import { assertReplayProjection } from '../src/development-history.mjs';

test('squashed PR restores all 18 commits with unified identity, exact messages, paths and stable mappings', async () => {
  const f = await developmentFixture();
  await discover(f.receiver, { kind: 'latest' }, f.provider);
  await f.receiver.start();
  await f.receiver.prepare();
  const state = await f.receiver.status(), d = state.active;
  assert.equal(await git(f.receiver.git.directory, ['rev-list', '--count', `${f.internalBase}..${d.candidate}`]), '18');
  assert.equal(d.source.developmentCommitCount, 18);
  assert.equal(d.commits.length, 1, 'main landing remains a separate provenance range');
  assert.equal(d.developmentMappings.length, 18);
  let merges = 0;
  for (const mapping of d.developmentMappings) {
    const message = async (sha) => {
      const object = await git(f.receiver.git.directory, ['cat-file', 'commit', sha], { binary: true });
      return object.subarray(object.indexOf(Buffer.from('\n\n')) + 2);
    };
    assert.deepEqual(await message(mapping.internal), await message(mapping.source));
    assert.equal(await git(f.receiver.git.directory, ['show', '-s', '--format=%an|%ae|%cn|%ce', mapping.internal]),
      'Internal Sync|sync@example.invalid|Internal Sync|sync@example.invalid');
    assert.equal(await git(f.receiver.git.directory, ['show', `${mapping.internal}:README.md`]), 'internal readme');
    if ((await git(f.receiver.git.directory, ['show', '-s', '--format=%P', mapping.source])).split(' ').length === 2) {
      merges++;
      assert.equal((await git(f.receiver.git.directory, ['show', '-s', '--format=%P', mapping.internal])).split(' ').length, 2);
    }
  }
  assert.equal(merges, 2, 'main-into-feature merge topology is retained without importing accepted main work twice');
  assert.equal(d.commitMappings[0].source, f.target);
  assert.equal(mappedCommit(state, f.target), d.candidate);
  assert.equal((await buildCandidate(f.receiver, state, d)).head, d.candidate);
  const required = requiredCommits([{ path: 'ledger.json', content: JSON.stringify(state) }]);
  assert.ok(d.developmentMappings.every((m) => required.includes(m.source) && required.includes(m.internal)));
  await f.receiver.linkPr('https://internal.example/core/merge_requests/1');
  await f.merge(d);
  const restarted = new Receiver(f.config);
  restarted.git.config = { ...restarted.config, sourceUrl: f.source };
  await restarted.recover();
  await restarted.receipts([]);
  assert.equal((await restarted.status()).accepted.upstream, f.target);
  assert.equal((await restarted.status()).deliveries[0].status, 'COMPLETE');
});

test('incomplete development metadata stops before Issue creation or candidate publication', async () => {
  const f = await developmentFixture(3);
  f.commits.pop();
  await assert.rejects(() => discover(f.receiver, { kind: 'latest' }, f.provider), { code: 'PR_HISTORY_INCOMPLETE' });
  assert.equal((await f.receiver.status()).queue.length, 0);
});

test('development head drift and a different final core tree cannot be disguised by a repair commit', async () => {
  const f = await developmentFixture(3);
  await discover(f.receiver, { kind: 'latest' }, f.provider);
  await f.receiver.start();
  await writeFile(join(f.source, 'core.txt'), 'unrelated head drift');
  await git(f.source, ['add', '.']);
  await git(f.source, ['commit', '-m', 'extra main change']);
  await git(f.source, ['update-ref', 'refs/pull/1405/head', 'HEAD']);
  await assert.rejects(() => f.receiver.prepare(), { code: 'PR_HISTORY_CHANGED' });
  const d = (await f.receiver.status()).active;
  assert.equal(d.candidate, null);
  assert.equal(await f.receiver.git.remoteBranch(d.branch), null);
});

test('a landing with extra conflict-resolution changes pauses instead of adding an unrequested nineteenth commit', async () => {
  const f = await developmentFixture(3);
  await writeFile(join(f.source, 'extra-core.txt'), 'landing-only resolution');
  await git(f.source, ['add', '.']);
  await git(f.source, ['commit', '--amend', '--no-edit']);
  f.pr.merge_commit_sha = await git(f.source, ['rev-parse', 'HEAD']);
  await assert.rejects(() => discover(f.receiver, { kind: 'latest' }, f.provider), { code: 'PR_REPLAY_TREE_MISMATCH' });
  assert.equal((await f.receiver.status()).queue.length, 0);
});

test('an interleaved main landing is accepted only when its tree is already in the internal baseline', async () => {
  const f = await repositoriesWithoutClone();
  const base = await f.commit('base.txt', 'base', 'base');
  await git(f.repo, ['switch', '-c', 'feature']);
  await f.commit('feature.txt', 'one', 'feature one');
  const head = await f.commit('feature.txt', 'two', 'feature two');
  await git(f.repo, ['switch', 'main']);
  const parallel = await f.commit('parallel.txt', 'accepted', 'parallel main');
  await git(f.repo, ['merge', '--squash', 'feature']);
  await git(f.repo, ['commit', '-m', 'squashed feature']);
  const landing = await git(f.repo, ['rev-parse', 'HEAD']);
  await git(f.repo, ['switch', '-c', 'internal', base]);
  const internal = await f.commit('parallel.txt', 'accepted', 'internal parallel');
  const receiver = { git: { directory: f.repo, sha: async () => internal }, config: { internalPaths: [] } };
  const replay = { landingBase: base, head, landing, commits: [head] };
  await assertReplayProjection(receiver, { base: { internal } }, replay);
  await assertReplayProjection(receiver, { base: {} }, replay);
  await assert.rejects(
    () => assertReplayProjection(receiver, { base: { internal: base } }, replay),
    { code: 'PR_REPLAY_TREE_MISMATCH' },
  );
  assert.notEqual(parallel, internal);
});

test('files a landing inherits from its parent are parallel main work, not this PR', async () => {
  const f = await repositoriesWithoutClone();
  const base = await f.commit('base.txt', 'base', 'base');
  await git(f.repo, ['switch', '-c', 'feature']);
  await f.commit('feature.txt', 'one', 'feature one');
  await git(f.repo, ['switch', 'main']);
  // 并行 main 提交：本 PR 的 head 线上没有它
  const parallel = await f.commit('parallel.txt', 'accepted', 'parallel main');
  await git(f.repo, ['merge', '--squash', 'feature']);
  await git(f.repo, ['commit', '-m', 'squashed feature']);
  const landing = await git(f.repo, ['rev-parse', 'HEAD']);
  // head 从 base 另起一条线，只带 PR 自己的改动，不含 parallel.txt
  await git(f.repo, ['switch', '-c', 'headline', base]);
  await writeFile(join(f.repo, 'feature.txt'), 'one');
  await git(f.repo, ['add', 'feature.txt']);
  await git(f.repo, ['commit', '-m', 'feature one (head)']);
  const head = await git(f.repo, ['rev-parse', 'HEAD']);
  const receiver = { git: { directory: f.repo, sha: async () => base }, config: { internalPaths: [] } };
  // landing==parent 的 parallel.txt 继承自并行 main，不得归因到本 PR
  await assertReplayProjection(receiver, { base: {} }, { landingBase: parallel, head, landing, commits: [head] });
});

async function repositoriesWithoutClone() {
  const repo = await mkdtemp(join(process.cwd(), '.repo-sync-tests', 'projection-'));
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Projection Test']);
  await git(repo, ['config', 'user.email', 'projection@example.invalid']);
  const commit = async (path, content, message) => {
    await writeFile(join(repo, path), content);
    await git(repo, ['add', path]);
    await git(repo, ['commit', '-m', message]);
    return git(repo, ['rev-parse', 'HEAD']);
  };
  return { repo, commit };
}

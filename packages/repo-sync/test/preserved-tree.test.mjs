import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { preservedTree } from '../src/preserved-tree.mjs';
import { git } from '../src/process.mjs';

async function fixture() {
  const repo = await mkdtemp(join(process.cwd(), '.repo-sync-tests', 'preserved-'));
  const stateDir = join(repo, '..', `${repo.split(/[\\/]/).pop()}-state`);
  await mkdir(repo, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Preserved Test']);
  await git(repo, ['config', 'user.email', 'preserved@example.invalid']);
  const commit = async (path, content, message) => {
    await writeFile(join(repo, path), content);
    await git(repo, ['add', path]);
    await git(repo, ['commit', '-m', message]);
    return git(repo, ['rev-parse', 'HEAD']);
  };
  const receiver = {
    directory: repo,
    config: { stateDir, internalPaths: [] },
    tree: async (rev) => git(repo, ['rev-parse', `${rev}^{tree}`]),
  };
  return { repo, receiver, commit };
}

const treePaths = async (repo, tree) =>
  (await git(repo, ['ls-tree', '-r', '--name-only', tree])).split('\n').filter(Boolean).sort();

test('a replay commit does not delete files another landing already brought in', async () => {
  const f = await fixture();
  const base = await f.commit('base.txt', 'base', 'base');
  // 内部已接收的并行 landing
  const internal = await f.commit('parallel.txt', 'accepted', 'parallel main landed');
  // 来源血统：从 base 分出，天然不含 parallel.txt
  await git(f.repo, ['switch', '-c', 'source', base]);
  const source = await f.commit('feature.txt', 'one', 'feature one');

  const tree = await preservedTree(f.receiver, source, internal, 'candidate-1', base);
  assert.deepEqual(await treePaths(f.repo, tree), ['base.txt', 'feature.txt', 'parallel.txt']);
});

test('a commit that really deletes a file still deletes it', async () => {
  const f = await fixture();
  const base = await f.commit('base.txt', 'base', 'base');
  const internal = await f.commit('gone.txt', 'temporary', 'temporary file');
  await git(f.repo, ['switch', '-c', 'source', internal]);
  await git(f.repo, ['rm', 'gone.txt']);
  await git(f.repo, ['commit', '-m', 'delete the temporary file']);
  const source = await git(f.repo, ['rev-parse', 'HEAD']);

  const tree = await preservedTree(f.receiver, source, internal, 'candidate-2', internal);
  assert.deepEqual(await treePaths(f.repo, tree), ['base.txt']);
});

test('an authoritative landing snapshot does not resurrect internal core files absent from the landing', async () => {
  const f = await fixture();
  const target = await f.commit('base.txt', 'base', 'base');
  const internal = await f.commit('gone.txt', 'temporary', 'previously accepted file');
  const tree = await preservedTree(f.receiver, target, internal, 'landing-snapshot');
  assert.deepEqual(await treePaths(f.repo, tree), ['base.txt']);
});

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { command, git } from '../src/process.mjs';

export async function repositories() {
  const temporary = join(process.cwd(), '.repo-sync-tests');
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, 'repo-sync-test-'));
  const source = join(root, 'source');
  const internal = join(root, 'internal.git');
  const review = join(root, 'review');
  await mkdir(source);
  await git(source, ['init', '-b', 'main']);
  await git(source, ['config', 'user.name', 'Synthetic Test']);
  await git(source, ['config', 'user.email', 'test@example.invalid']);
  const commit = async (value) => {
    await writeFile(join(source, 'core.txt'), value);
    await git(source, ['add', 'core.txt']);
    await git(source, ['commit', '-m', value]);
    return git(source, ['rev-parse', 'HEAD']);
  };
  const u0 = await commit('initial');
  await mkdir(internal);
  await git(internal, ['init', '--bare', '-b', 'main']);
  await command('git', ['clone', relative(process.cwd(), internal), review]);
  await git(review, ['config', 'user.name', 'Synthetic Review']);
  await git(review, ['config', 'user.email', 'review@example.invalid']);
  await writeFile(join(review, 'core.txt'), 'initial');
  await git(review, ['add', 'core.txt']);
  await git(review, ['commit', '-m', 'independent snapshot']);
  await git(review, ['push', 'origin', 'main']);
  const i0 = await git(review, ['rev-parse', 'HEAD']);
  const u1 = await commit('first');
  const u2 = await commit('second');
  const config = {
    allowLocal: true,
    sourceUrl: source,
    internalUrl: internal,
    sourceBranch: 'main',
    targetBranch: 'main',
    stateDir: join(root, 'private'),
    commitClosureVerified: true,
    checks: [{ command: process.execPath, args: ['-e', "require('node:fs').accessSync('core.txt')"] }],
  };
  const merge = async (delivery) => {
    await git(review, ['fetch', 'origin', delivery.branch]);
    await git(review, ['merge', '--no-ff', 'FETCH_HEAD', '-m', 'synthetic platform approval']);
    await git(review, ['push', 'origin', 'main']);
    return git(review, ['rev-parse', 'HEAD']);
  };
  const issue = {
    sourceId: 'issue-71',
    number: 71,
    url: 'https://github.com/demo/core/issues/71',
    title: '完善通用插件能力',
    relation: 'closes',
    requiredTargets: [u1, u2],
  };
  const plans = [u1, u2].map((target, i) => ({
    target,
    source: {
      id: `pr-${i + 1}`,
      number: i + 1,
      title: ['增加通用能力接口', '完善通用能力验证'][i],
      url: `https://github.com/demo/core/pull/${i + 1}`,
    },
    issues: [issue],
  }));
  return { root, source, internal, review, config, u0, i0, u1, u2, merge, plans };
}

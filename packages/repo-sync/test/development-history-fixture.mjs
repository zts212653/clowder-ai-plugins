import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Receiver } from '../src/engine.mjs';
import { git } from '../src/process.mjs';
import { repositories } from './fixtures.mjs';

export async function developmentFixture(count = 18, { staleMain = false, sharedContents = false } = {}) {
  const f = await repositories();
  await writeFile(join(f.review, 'core.txt'), 'second');
  await writeFile(join(f.review, 'README.md'), 'internal readme');
  await git(f.review, ['add', '.']);
  await git(f.review, ['commit', '-m', 'internal accepted second']);
  await git(f.review, ['push', 'origin', 'main']);
  let internal = await git(f.review, ['rev-parse', 'HEAD']), base = f.u2;
  if (staleMain) {
    for (const directory of [f.source, f.review]) {
      for (const path of ['inherited.txt', 'removed.txt', 'renamed.txt', 'pr-delete.txt'])
        await writeFile(join(directory, path), sharedContents ? 'old main' : `old main ${path}`);
      await git(directory, ['add', '.']);
      await git(directory, ['commit', '-m', 'shared baseline files']);
    }
    base = await git(f.source, ['rev-parse', 'HEAD']);
    internal = await git(f.review, ['rev-parse', 'HEAD']);
  }
  await git(f.source, ['switch', '-c', 'feature']);
  const commits = [];
  for (let index = 0; index < count; index++) {
    if (count === 18 && [6, 14].includes(index)) {
      await git(f.source, ['switch', 'main']);
      const path = `accepted-${index}.txt`;
      await writeFile(join(f.source, path), `accepted main ${index}`);
      await git(f.source, ['add', '.']);
      await git(f.source, ['commit', '-m', `accepted main ${index}`]);
      base = await git(f.source, ['rev-parse', 'HEAD']);
      await writeFile(join(f.review, path), `accepted main ${index}`);
      await git(f.review, ['add', '.']);
      await git(f.review, ['commit', '-m', `accepted internal ${index}`]);
      await git(f.review, ['push', 'origin', 'main']);
      internal = await git(f.review, ['rev-parse', 'HEAD']);
      await git(f.source, ['switch', 'feature']);
      await git(f.source, ['merge', '--no-ff', 'main', '-m', `development merge ${index}`]);
    } else {
    if (staleMain && index === 0) await git(f.source, ['rm', 'pr-delete.txt']);
    if (index !== 1) await writeFile(join(f.source, 'core.txt'), `feature ${index}`);
    await writeFile(join(f.source, 'README.md'), `source ${index}`);
    await git(f.source, ['add', '.']);
    await git(f.source, ['commit', '--allow-empty', '-m', `development ${index}`]);
    }
    const sha = await git(f.source, ['rev-parse', 'HEAD']);
    commits.push({ sha, commit: { message: `development ${index}` } });
  }
  const head = commits.at(-1).sha;
  await git(f.source, ['update-ref', 'refs/pull/1405/head', head]);
  await git(f.source, ['switch', 'main']);
  if (staleMain) {
    for (const directory of [f.source, f.review]) {
      await writeFile(join(directory, 'inherited.txt'), 'new accepted main');
      await writeFile(join(directory, 'parallel.txt'), 'parallel main addition');
      await rm(join(directory, 'removed.txt'));
      await git(directory, ['mv', 'renamed.txt', 'new-name.txt']);
      await git(directory, ['add', '.']);
      await git(directory, ['commit', '-m', 'parallel main changes before squash']);
    }
    base = await git(f.source, ['rev-parse', 'HEAD']);
    internal = await git(f.review, ['rev-parse', 'HEAD']);
  }
  await git(f.review, ['push', 'origin', 'main']);
  await git(f.source, ['merge', '--squash', 'feature']);
  await git(f.source, ['commit', '-m', 'squashed feature (#1405)']);
  const target = await git(f.source, ['rev-parse', 'HEAD']);
  const pr = {
    node_id: 'pr-1405', number: 1405, title: 'feat(site): synthetic development history',
    html_url: 'https://github.com/demo/core/pull/1405', merged: true,
    merged_at: '2026-10-16T00:00:00Z', merge_commit_sha: target,
    base: { ref: 'main', sha: base }, head: { sha: head }, commits: count,
  };
  const provider = {
    api: async (path) => {
      if (path === 'repos/demo/core') return { node_id: 'repo-1' };
      if (path.includes('/commits/') && path.includes('/pulls')) return [pr];
      if (path.startsWith('repos/demo/core/pulls/1405/commits')) return commits;
      if (path === 'repos/demo/core/pulls/1405') return pr;
      throw Error(`Unexpected fixture API ${path}`);
    },
    collectIssues: async () => [],
  };
  const config = {
    ...f.config, sourceUrl: 'https://github.com/demo/core.git', internalPaths: ['README.md'],
    commitStrategy: 'rewrite', receivingIdentity: { name: 'Internal Sync', email: 'sync@example.invalid' },
  };
  const receiver = new Receiver(config);
  receiver.git.config = { ...receiver.config, sourceUrl: f.source };
  await receiver.adopt(base, internal);
  return { ...f, u2: base, receiver, config, provider, pr, commits, target, internalBase: internal, head };
}

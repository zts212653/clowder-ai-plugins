import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '../src/process.mjs';
import { repositories } from './fixtures.mjs';

export async function continuousRepositories() {
  const f = await repositories();
  await git(f.source, ['switch', '-c', 'releases', f.u0]);
  await writeFile(join(f.source, 'README.md'), 'English upstream baseline\n');
  await writeFile(join(f.source, 'README.cn.md'), '上游中文版\n');
  await git(f.source, ['add', '.']);
  await git(f.source, ['commit', '-m', 'documentation baseline']);
  const u0 = await git(f.source, ['rev-parse', 'HEAD']);
  await git(f.source, ['tag', 'v1.0.0']);
  await writeFile(join(f.review, 'README.md'), '内部默认中文版\n');
  await writeFile(join(f.review, 'README.en.md'), 'Internal English documentation\n');
  await git(f.review, ['add', '.']);
  await git(f.review, ['commit', '-m', 'internal documentation naming']);
  await git(f.review, ['push', 'origin', 'main']);
  const i0 = await git(f.review, ['rev-parse', 'HEAD']);
  const targets = [];
  for (const value of ['first', 'second']) {
    await writeFile(join(f.source, 'core.txt'), value);
    await writeFile(join(f.source, 'README.md'), `Upstream ${value} English\n`);
    await writeFile(join(f.source, 'README.cn.md'), `上游 ${value} 中文\n`);
    await git(f.source, ['add', '.']);
    await git(f.source, ['commit', '-m', `source ${value} delivery`]);
    targets.push(await git(f.source, ['rev-parse', 'HEAD']));
  }
  await git(f.source, ['tag', '-a', 'v2.0.0', '-m', 'second delivery']);
  const config = {
    ...f.config,
    sourceBranch: 'releases',
    mode: 'continuous',
    internalWebUrl: 'https://codehub.example/core',
    internalPaths: ['README.md', 'README.cn.md', 'README.en.md'],
  };
  const plans = f.plans.map((plan, index) => ({
    ...plan,
    target: targets[index],
    issues: plan.issues.map((issue) => ({
      ...issue,
      requiredTargets: targets,
    })),
  }));
  return { ...f, config, u0, i0, u1: targets[0], u2: targets[1], plans };
}

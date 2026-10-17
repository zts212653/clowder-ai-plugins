import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '../src/process.mjs';
import { repositories } from './fixtures.mjs';

export async function versionRepositories() {
  const f = await repositories();
  await git(f.source, ['switch', '-c', 'releases', f.u0]);
  const baseReadme = '介绍\n\n运行说明\n\n联系说明\n';
  await writeFile(join(f.source, 'README.md'), baseReadme);
  await writeFile(join(f.source, 'OWNED.md'), '上游说明 v1\n');
  await git(f.source, ['add', '.']);
  await git(f.source, ['commit', '-m', 'release baseline']);
  const u0 = await git(f.source, ['rev-parse', 'HEAD']);
  await git(f.source, ['tag', 'v1.0.0']);
  await mkdir(join(f.review, 'internal-docs'));
  await writeFile(join(f.review, 'internal-docs', 'guide.md'), '内部独立说明\n');
  await writeFile(join(f.review, 'README.md'), '介绍\n\n运行说明\n\n内部联系说明\n');
  await writeFile(join(f.review, 'OWNED.md'), '内部维护说明\n');
  await git(f.review, ['add', '.']);
  await git(f.review, ['commit', '-m', 'internal customization']);
  await git(f.review, ['push', 'origin', 'main']);
  const i0 = await git(f.review, ['rev-parse', 'HEAD']);
  await writeFile(join(f.source, 'core.txt'), 'release two');
  await writeFile(join(f.source, 'README.md'), '新版介绍\n\n运行说明\n\n联系说明\n');
  await writeFile(join(f.source, 'OWNED.md'), '上游说明 v2\n');
  await git(f.source, ['add', '.']);
  await git(f.source, ['commit', '-m', 'Fixes #71: source release change']);
  const u1 = await git(f.source, ['rev-parse', 'HEAD']);
  await git(f.source, ['tag', '-a', 'v2.0.0', '-m', 'release two']);
  return {
    ...f,
    u0,
    i0,
    u1,
    config: {
      ...f.config,
      sourceBranch: 'releases',
      mode: 'version',
      commitClosureVerified: false,
      internalPaths: ['internal-docs/', 'OWNED.md', 'README.md'],
      mergePaths: [],
    },
  };
}

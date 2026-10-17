import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProjectWorkspace } from '../src/projects.mjs';

test('SSH and HTTPS spellings cannot register two executors for the same receiving repository and branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repo-sync-owner-alias-'));
  const projects = await createProjectWorkspace(join(root, 'config.json'));
  const a = await projects.connection();
  const input = {
    action: 'configure-repositories',
    expectedRevision: null,
    mode: 'version',
    sourceUrl: 'https://github.com/demo/core.git',
    internalUrl: 'git@internal.example:team/core.git',
    sourceBranch: 'main',
    targetBranch: 'main',
    internalWebUrl: 'https://internal.example/team/core',
    internalPaths: [],
    mergePaths: [],
    prMode: 'manual',
    commitClosureVerified: false,
  };
  await a.run(input);
  const project = await projects.create({
    action: 'create',
    name: '另一写法',
    requestId: 'a'.repeat(32),
    expectedRevision: (await projects.list()).revision,
  });
  const b = await projects.connection(project.id);
  for (const internalUrl of [
    'https://internal.example/team/core',
    'ssh://git@internal.example/team/core.git',
    'https://INTERNAL.example/team/core.git/',
  ]) {
    await assert.rejects(b.run({ ...input, internalUrl }), { code: 'PROJECT_DESTINATION_IN_USE' });
  }
  await b.run({ ...input, internalUrl: 'https://internal.example/team/core.git', targetBranch: 'release' });
  assert.equal((await b.current()).config.targetBranch, 'release');
});

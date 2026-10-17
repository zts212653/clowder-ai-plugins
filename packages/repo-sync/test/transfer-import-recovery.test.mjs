import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { Receiver } from '../src/engine.mjs';
import { createProjectWorkspace } from '../src/projects.mjs';
import { readPrivate, writePrivate } from '../src/private-config.mjs';
import { createTransfer } from '../src/transfer-package.mjs';
import { saveTransferState } from '../src/transfer-state.mjs';

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'repo-sync-import-recovery-')),
    file = join(folder, 'config.json');
  const receiver = new Receiver({
    sourceUrl: 'https://github.com/demo/core.git',
    internalUrl: 'git@internal.example:core.git',
    sourceBranch: 'main',
    targetBranch: 'main',
    stateDir: join(folder, 'source'),
    mode: 'version',
    internalPaths: ['README.md'],
    checks: [{ command: 'git', args: ['fsck', '--no-reflogs'] }],
    checkProfile: 'git-integrity',
  });
  const pkg = await createTransfer(receiver, { kind: 'template', name: '原项目', projectId: 'default' });
  const projects = await createProjectWorkspace(file);
  await projects.transfers.preview(pkg);
  const input = { packageId: pkg.packageId, name: '新项目', expectedWorkspaceRevision: null };
  const result = await projects.transfers.install(input);
  return { folder, file, projects, pkg, input, result };
}

test('restart after directory commit but before registry commit only completes original registration', async () => {
  const f = await fixture(),
    id = f.result.project.id,
    connection = await f.projects.connection(id);
  const config = connection.describe().configurationFile,
    receipt = join(dirname(config), 'import-receipt.json');
  const original = await readFile(receipt, 'utf8'),
    originalConfig = await readFile(config, 'utf8');
  const registry = (await readPrivate(`${f.file}.projects.json`)).config;
  registry.projects = registry.projects.filter((p) => p.id !== id);
  await writePrivate(`${f.file}.projects.json`, registry);
  const restart = await createProjectWorkspace(f.file);
  const recovered = await restart.transfers.install({
    ...f.input,
    expectedWorkspaceRevision: (await restart.list()).revision,
  });
  assert.equal(recovered.reused, true);
  assert.deepEqual(recovered.project, f.result.project);
  assert.equal((await restart.list()).projects.length, 2);
  assert.equal(await readFile(receipt, 'utf8'), original);
  assert.equal(await readFile(config, 'utf8'), originalConfig);
  assert.equal((await restart.transfers.install(f.input)).reused, true);
});

test('replaying an old template cannot claim a project whose binding was intentionally changed', async () => {
  const f = await fixture(),
    id = f.result.project.id,
    connection = await f.projects.connection(id);
  const old = await connection.current(),
    path = connection.describe().configurationFile;
  await saveTransferState(old.config, {
    ...(await readPrivate(join(old.config.stateDir, 'transfer.json'))).config,
    status: 'ACTIVE',
  });
  const changed = { ...old.config, internalUrl: 'git@internal.example:another.git' };
  delete changed.bindingId;
  await writePrivate(path, new Receiver(changed).config);
  await assert.rejects(f.projects.transfers.install(f.input), { code: 'TRANSFER_RECEIPT_CONFLICT' });
  assert.equal((await connection.current()).config.internalUrl, changed.internalUrl);
  assert.equal((await f.projects.list()).projects.length, 2);
});

test('concurrent same-package imports have one owner and can recover the original receipt', async () => {
  const f = await fixture(),
    id = f.result.project.id;
  const results = await Promise.allSettled([
    f.projects.transfers.install(f.input),
    f.projects.transfers.install(f.input),
  ]);
  for (const result of results) {
    if (result.status === 'fulfilled') assert.equal(result.value.project.id, id);
    else assert.equal(result.reason.code, 'CONFIGURATION_BUSY');
  }
  assert.equal((await f.projects.transfers.install(f.input)).project.id, id);
  assert.equal((await f.projects.list()).projects.length, 2);
});

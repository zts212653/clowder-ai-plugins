import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Receiver } from '../src/engine.mjs';
import { repositories } from './fixtures.mjs';

async function service(file) {
  const probe = createServer();
  await new Promise((done) => probe.listen(0, '127.0.0.1', done));
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const child = spawn(process.execPath, ['src/cli.mjs', 'setup', file, String(port)], {
    windowsHide: true,
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let count = 0; count < 100; count++) {
    try {
      const response = await fetch(`${base}/api/status`);
      if (response.ok) return { child, base, status: await response.json() };
    } catch {}
    await new Promise((done) => setTimeout(done, 50));
  }
  child.kill();
  throw Error('formal CLI failed to start');
}
test('formal CLI preserves an adopted continuous project and adds an independent version project in the same workbench', async () => {
  const f = await repositories(),
    folder = await mkdtemp(join(tmpdir(), 'repo-sync-multiple-'));
  const file = join(folder, 'config.json');
  const config = {
    ...f.config,
    configurationSource: 'workbench',
    internalWebUrl: 'https://internal.example/core',
  };
  await writeFile(file, JSON.stringify(config, null, 2));
  const original = new Receiver(config);
  await original.adopt(f.u0, f.i0);
  const before = await readFile(file, 'utf8'),
    ledger = await readFile(original.store.path, 'utf8');
  const s = await service(file);
  try {
    const response = await fetch(`${s.base}/api/projects`, {
      method: 'POST',
      headers: { 'X-Repo-Sync-Token': s.status.token },
      body: JSON.stringify({
        action: 'create',
        requestId: 'a'.repeat(32),
        name: '版本同步项目',
        expectedRevision: s.status.workspace?.revision ?? null,
      }),
    });
    assert.equal(response.status, 201, 'an adopted first project must not prevent adding another project');
    const created = await response.json(),
      id = created.project.id;
    const blank = await (await fetch(`${s.base}/api/status?project=${id}`)).json();
    assert.equal(blank.config, null);
    const saved = await fetch(`${s.base}/api/action?project=${id}`, {
      method: 'POST',
      headers: { 'X-Repo-Sync-Token': blank.token },
      body: JSON.stringify({
        action: 'configure-repositories',
        projectId: id,
        expectedRevision: blank.connection.revision,
        sourceUrl: 'https://github.com/demo/other.git',
        internalUrl: 'git@internal.example:team/other.git',
        sourceBranch: 'main',
        targetBranch: 'main',
        internalWebUrl: 'https://internal.example/other',
        mode: 'version',
        internalPaths: ['README.md'],
        mergePaths: [],
        prMode: 'git',
        commitClosureVerified: false,
      }),
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).config.mode, 'version');
    const existing = await (await fetch(`${s.base}/api/status?project=default`)).json();
    assert.equal(existing.config.mode, 'continuous');
    assert.equal(existing.connection.editable, false);
    assert.equal(existing.workspace.projects.length, 2);
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal(await readFile(original.store.path, 'utf8'), ledger);
  } finally {
    const exited = once(s.child, 'exit');
    s.child.kill();
    await exited;
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProjectWorkspace } from '../src/projects.mjs';
import { createReceiverServer } from '../src/server.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'repo-sync-transfer-http-'));
  const file = join(directory, 'config.json');
  const projects = await createProjectWorkspace(file);
  const connection = await projects.connection();
  await connection.run({
    action: 'configure-repositories',
    expectedRevision: null,
    mode: 'version',
    sourceUrl: 'https://github.com/demo/core.git',
    internalUrl: 'git@internal.example:team/core.git',
    sourceBranch: 'main',
    targetBranch: 'main',
    internalWebUrl: 'https://internal.example/team/core',
    internalPaths: ['README.md'],
    mergePaths: [],
    prMode: 'manual',
    commitClosureVerified: false,
  });
  const server = createReceiverServer(null, { projects });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const url = `http://127.0.0.1:${server.address().port}`;
  const status = await fetch(`${url}/api/status`).then((r) => r.json());
  const request = async (path, value, csrf = status.token) => {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Repo-Sync-Token': csrf },
      body: JSON.stringify(value),
    });
    return { status: response.status, value: await response.json() };
  };
  return { file, projects, connection, status, request, url };
}

async function destination(t) {
  const directory = await mkdtemp(join(tmpdir(), 'repo-sync-transfer-destination-'));
  const projects = await createProjectWorkspace(join(directory, 'config.json'));
  const server = createReceiverServer(null, { projects });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.shutdown());
  const url = `http://127.0.0.1:${server.address().port}`;
  const status = await fetch(`${url}/api/status`).then((r) => r.json());
  const request = async (path, value, csrf = status.token) => {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Repo-Sync-Token': csrf,
      },
      body: JSON.stringify(value),
    });
    return { status: response.status, value: await response.json() };
  };
  return { projects, request, url, status };
}
async function template(f) {
  const result = await f.request('/api/transfers/export', {
    kind: 'template',
    projectId: 'default',
    expectedRevision: f.status.connection.revision,
    expectedBinding: f.status.config.bindingId,
  });
  assert.equal(result.status, 200);
  return result.value;
}

test('settings can export a credential-free template without touching the original configuration', async (t) => {
  const f = await fixture(t),
    before = await readFile(f.file, 'utf8');
  const result = await f.request('/api/transfers/export', {
    kind: 'template',
    expectedRevision: f.status.connection.revision,
    expectedBinding: f.status.config.bindingId,
    projectId: 'default',
  });
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(result.value.format, 'clowder-repo-sync-transfer');
  assert.equal(result.value.kind, 'template');
  assert.equal(result.value.config.sourceUrl, f.status.config.sourceUrl);
  assert.equal(result.value.config.stateDir, undefined);
  assert.equal(await readFile(f.file, 'utf8'), before);
});

test('template preview is read-only; repeat import reuses the same project and never overwrites its sibling', async (t) => {
  const source = await fixture(t),
    target = await destination(t),
    pkg = await template(source);
  const preview = await target.request('/api/transfers/preview', pkg);
  assert.equal(preview.status, 200);
  assert.equal((await target.projects.list()).projects.length, 1);
  const input = { packageId: pkg.packageId, name: '接收项目', expectedWorkspaceRevision: null, projectId: 'default' };
  const installed = await target.request('/api/transfers/import', input);
  assert.equal(installed.status, 200, JSON.stringify(installed.value));
  const id = installed.value.project.id;
  const replayed = await target.request('/api/transfers/import', input);
  assert.equal(replayed.status, 200, JSON.stringify(replayed.value));
  assert.deepEqual(replayed.value.project, installed.value.project);
  assert.equal(replayed.value.reused, true);
  assert.equal((await target.projects.list()).projects.length, 2);
  const current = await fetch(`${target.url}/api/status?project=${id}`).then((r) => r.json());
  assert.equal(current.transfer.status, 'IMPORTED');
  assert.equal(current.state, null);
  assert.notEqual(current.connection.stateDir, source.status.connection.stateDir);
  const blocked = await target.request(`/api/tasks?project=${id}`, {
    action: 'adopt',
    requestId: 'a'.repeat(32),
    projectId: id,
    expectedRevision: current.connection.revision,
    expectedBinding: current.config.bindingId,
    upstream: '1'.repeat(40),
    internal: '2'.repeat(40),
  });
  assert.equal(blocked.value.code, 'TRANSFER_ACTIVATION_REQUIRED');
  assert.equal(await (await target.projects.connection()).current(), null);
});

test('uploads reject corruption, credentials, cross-site requests and duplicate destination bindings', async (t) => {
  const source = await fixture(t),
    pkg = await template(source);
  assert.equal((await source.request('/api/transfers/preview', pkg, 'bad')).status, 403);
  const changed = structuredClone(pkg);
  changed.config.targetBranch = 'other';
  assert.equal((await source.request('/api/transfers/preview', changed)).value.code, 'TRANSFER_DIGEST_MISMATCH');
  const secret = structuredClone(pkg);
  secret.config.token = 'DO_NOT_EXPORT';
  assert.equal((await source.request('/api/transfers/preview', secret)).value.code, 'TRANSFER_CONFIG_UNKNOWN');
  const preview = await source.request('/api/transfers/preview', pkg);
  assert.equal(preview.status, 200);
  const conflict = await source.request('/api/transfers/import', {
    packageId: pkg.packageId,
    name: '副本',
    expectedWorkspaceRevision: source.status.workspace.revision,
    projectId: 'default',
  });
  assert.equal(conflict.value.code, 'PROJECT_DESTINATION_IN_USE');
  assert.equal((await source.projects.list()).projects.length, 1);
  const response = await fetch(`${source.url}/api/transfers/preview`, {
    method: 'POST',
    headers: {
      Origin: 'https://external.example',
      'X-Repo-Sync-Token': source.status.token,
    },
    body: JSON.stringify(pkg),
  });
  assert.equal(response.status, 403);
});

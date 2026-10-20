import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createProjectWorkspace } from '../src/projects.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { repositories } from './fixtures.mjs';

async function fixture() {
  const a = await repositories(),
    b = await repositories(),
    folder = await mkdtemp(join(tmpdir(), 'repo-sync-project-tasks-'));
  const file = join(folder, 'config.json');
  await writeFile(file, JSON.stringify(a.config));
  const projects = await createProjectWorkspace(file),
    created = await projects.create({
      action: 'create',
      name: 'B',
      requestId: 'b'.repeat(32),
      expectedRevision: null,
    });
  const cb = await projects.connection(created.id),
    path = cb.describe().configurationFile;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ ...b.config, mode: 'version' }));
  const ca = await projects.connection(),
    ra = await ca.current(),
    rb = await cb.current();
  await ra.adopt(a.u0, a.i0);
  await rb.adopt(b.u0, b.i0);
  const server = createReceiverServer(null, { projects });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`,
    bootstrap = await (await fetch(`${base}/api/status`)).json();
  const request = (path, input) =>
    fetch(base + path, {
      ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}),
      headers: { 'X-Repo-Sync-Token': bootstrap.token },
    });
  return { a, b, projects, id: created.id, ca, cb, ra, rb, server, request };
}
async function terminal(f, project, id) {
  for (let count = 0; count < 150; count++) {
    const response = await f.request(`/api/tasks/${id}?project=${project}`),
      value = (await response.json()).operation;
    if (value && !['RUNNING', 'CANCELLING'].includes(value.status)) return value;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw Error('scoped task did not settle');
}
test('A running task does not block B; each task, request and history stays in its original project', async () => {
  const f = await fixture();
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  const originalHeads = f.ra.git.heads.bind(f.ra.git);
  f.ra.git.heads = async () => {
    await gate;
    return originalHeads();
  };
  try {
    const aBefore = await readFile(f.ra.store.path, 'utf8'),
      aTask = 'a'.repeat(32),
      bTask = 'b'.repeat(32);
    assert.equal(
      (
        await f.request('/api/tasks?project=default', {
          action: 'heads',
          projectId: 'default',
          requestId: aTask,
          expectedBinding: f.ra.config.bindingId,
        })
      ).status,
      202,
    );
    assert.equal(
      (
        await f.request(`/api/tasks?project=${f.id}`, {
          action: 'heads',
          projectId: f.id,
          requestId: bTask,
          expectedBinding: f.rb.config.bindingId,
        })
      ).status,
      202,
    );
    const result = await terminal(f, f.id, bTask);
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.projectId, f.id);
    const status = await (await f.request(`/api/status?project=${f.id}`)).json();
    assert.equal(status.workspace.projects.find((item) => item.id === 'default').busy, true);
    assert.equal(
      (
        await f.request('/api/projects', {
          action: 'create',
          name: 'C while A runs',
          requestId: 'd'.repeat(32),
          expectedRevision: status.workspace.revision,
        })
      ).status,
      201,
    );
    assert.equal((await f.request(`/api/tasks/${aTask}?project=${f.id}`)).status, 404);
    assert.equal(
      (
        await f.request(`/api/tasks?project=${f.id}`, {
          action: 'heads',
          projectId: 'default',
          requestId: 'c'.repeat(32),
          expectedBinding: f.rb.config.bindingId,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request(`/api/tasks/${bTask}/cancel?project=${f.id}`, {
          projectId: 'default',
        })
      ).status,
      409,
    );
    assert.equal((await f.request(`/api/tasks/${aTask}?project=default`)).status, 200);
    assert.equal((await f.request(`/api/records?project=${f.id}`)).status, 200);
    release();
    const completed = await terminal(f, 'default', aTask);
    assert.equal(completed.status, 'SUCCEEDED');
    assert.equal(await readFile(f.ra.store.path, 'utf8'), aBefore);
  } finally {
    release();
    await f.server.shutdown();
  }
});
test('two simultaneous project status requests resolve their own connection and unknown IDs never fall back', async () => {
  const f = await fixture();
  try {
    for (let count = 0; count < 5; count++) {
      const values = await Promise.all([
        f.request('/api/status?project=default'),
        f.request(`/api/status?project=${f.id}`),
      ]);
      const [a, b] = await Promise.all(values.map((response) => response.json()));
      assert.equal(a.config.mode, 'continuous');
      assert.equal(b.config.mode, 'version');
      assert.equal(a.state.initial.upstream, f.a.u0);
      assert.equal(b.state.initial.upstream, f.b.u0);
    }
    const unknown = await f.request('/api/status?project=ffffffffffffffffffffffff');
    assert.equal(unknown.status, 409);
    assert.equal((await unknown.json()).code, 'PROJECT_NOT_FOUND');
  } finally {
    await f.server.shutdown();
  }
});

import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createProjectWorkspace } from '../src/projects.mjs';
import { createReceiverServer } from '../src/server.mjs';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'repo-sync-projects-')),
    file = join(directory, 'config.json');
  return { file, workspace: await createProjectWorkspace(file) };
}
const create = (name, requestId, expectedRevision = null) => ({
  action: 'create',
  name,
  requestId,
  expectedRevision,
});
const fields = {
  action: 'configure-repositories',
  sourceUrl: 'https://github.com/demo/core.git',
  internalUrl: 'git@internal.example:team/core.git',
  sourceBranch: 'main',
  targetBranch: 'main',
  internalWebUrl: 'https://internal.example/core',
  mode: 'version',
  internalPaths: ['README.md'],
  mergePaths: [],
  prMode: 'manual',
  commitClosureVerified: false,
  expectedRevision: null,
};

test('workspace bootstrap is read-only; creating and replaying a project do not overwrite the original configuration', async () => {
  const f = await fixture();
  await assert.rejects(access(f.file), { code: 'ENOENT' });
  await assert.rejects(access(`${f.file}.projects.json`), { code: 'ENOENT' });
  const project = await f.workspace.create(create('B', 'a'.repeat(32)));
  const other = await createProjectWorkspace(f.file);
  assert.deepEqual(await other.create(create('B', 'a'.repeat(32))), project);
  assert.equal((await other.list()).projects.length, 2);
  await assert.rejects(other.create(create('different', 'a'.repeat(32))), {
    code: 'PROJECT_REQUEST_CHANGED',
  });
  await assert.rejects(access(f.file), { code: 'ENOENT' });
});
test('two modes have separate private files and state directories; one known receiving branch cannot have two owners', async () => {
  const f = await fixture(),
    a = await f.workspace.connection();
  await a.run({ ...fields, mode: 'continuous', internalPaths: [] });
  const before = await readFile(f.file, 'utf8');
  const project = await f.workspace.create(create('B', 'b'.repeat(32), (await f.workspace.list()).revision));
  const b = await f.workspace.connection(project.id);
  await assert.rejects(b.run(fields), { code: 'PROJECT_DESTINATION_IN_USE' });
  await b.run({
    ...fields,
    internalUrl: 'git@internal.example:team/other.git',
    internalWebUrl: 'https://internal.example/other',
  });
  assert.equal((await a.current()).config.mode, 'continuous');
  assert.equal((await b.current()).config.mode, 'version');
  assert.notEqual(a.describe().configurationFile, b.describe().configurationFile);
  assert.notEqual((await a.current()).config.stateDir, (await b.current()).config.stateDir);
  assert.equal(await readFile(f.file, 'utf8'), before);
});
test('concurrent registry writers preserve the winner, reject stale edits and cannot inject project paths', async () => {
  const f = await fixture(),
    other = await createProjectWorkspace(f.file);
  const results = await Promise.allSettled([
    f.workspace.create(create('B', 'b'.repeat(32))),
    other.create(create('C', 'c'.repeat(32))),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.ok(
    ['CONFIGURATION_BUSY', 'PROJECT_LIST_CHANGED'].includes(
      results.find((item) => item.status === 'rejected').reason.code,
    ),
  );
  await assert.rejects(f.workspace.create(create('D', 'd'.repeat(32))), {
    code: 'PROJECT_LIST_CHANGED',
  });
  await assert.rejects(f.workspace.create({ ...create('E', 'e'.repeat(32)), path: '../other' }), {
    code: 'INVALID_PROJECT_INPUT',
  });
  await assert.rejects(f.workspace.connection('../other'), {
    code: 'PROJECT_NOT_FOUND',
  });
  assert.equal((await f.workspace.list()).projects.length, 2);
});
test('renaming a project preserves its stable identity, private file and original registration receipt', async () => {
  const f = await fixture(),
    input = create('B', 'b'.repeat(32)),
    project = await f.workspace.create(input);
  const before = (await f.workspace.connection(project.id)).describe().configurationFile;
  await f.workspace.rename({
    action: 'rename',
    id: project.id,
    name: '版本项目',
    expectedRevision: (await f.workspace.list()).revision,
  });
  assert.equal((await f.workspace.connection(project.id)).describe().configurationFile, before);
  assert.deepEqual(await f.workspace.create(input), {
    id: project.id,
    name: '版本项目',
  });
});
test('missing registered configuration is an error scoped to that project, not a fresh blank or failure of its sibling', async () => {
  const f = await fixture(),
    project = await f.workspace.create(create('B', 'b'.repeat(32)));
  const b = await f.workspace.connection(project.id);
  await b.run(fields);
  const path = b.describe().configurationFile;
  await rename(path, `${path}.backup`);
  const restarted = await createProjectWorkspace(f.file);
  await assert.rejects(restarted.connection(project.id), {
    code: 'PROJECT_CONFIGURATION_MISSING',
  });
  assert.equal(await (await restarted.connection()).current(), null);
  assert.equal(
    (await restarted.list()).projects.find((item) => item.id === project.id).error.code,
    'PROJECT_CONFIGURATION_MISSING',
  );
  await rename(`${path}.backup`, path);
  assert.equal((await (await restarted.connection(project.id)).current()).config.mode, 'version');
});
test('corrupt or missing project index is preserved and never silently replaced with a default-only list', async () => {
  const f = await fixture();
  await f.workspace.create(create('B', 'b'.repeat(32)));
  const path = `${f.file}.projects.json`,
    original = await readFile(path, 'utf8');
  await writeFile(path, '{"schema":999,"projects":[]}');
  await assert.rejects(createProjectWorkspace(f.file), {
    code: 'PROJECT_REGISTRY_INVALID',
  });
  assert.equal(await readFile(path, 'utf8'), '{"schema":999,"projects":[]}');
  await writeFile(path, original);
  await rename(path, `${path}.backup`);
  await assert.rejects(createProjectWorkspace(f.file), {
    code: 'PROJECT_REGISTRY_MISSING',
  });
  await rename(`${path}.backup`, path);
});

test('one damaged project does not prevent choosing a healthy project through the production HTTP entry', async () => {
  const f = await fixture(),
    project = await f.workspace.create(create('B', 'b'.repeat(32))),
    b = await f.workspace.connection(project.id);
  await b.run(fields);
  await writeFile(f.file, '{broken configuration');
  const restarted = await createProjectWorkspace(f.file),
    server = createReceiverServer(null, { projects: restarted });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const catalogue = await fetch(`${base}/api/projects`);
    assert.equal(catalogue.status, 200);
    const listed = await catalogue.json();
    assert.ok(listed.workspace.projects.find((item) => item.id === 'default').error);
    assert.equal((await fetch(`${base}/api/status?project=default`)).status, 409);
    const healthy = await fetch(`${base}/api/status?project=${project.id}`);
    assert.equal(healthy.status, 200);
    const status = await healthy.json();
    assert.equal(status.workspace.currentId, project.id);
    assert.equal(status.config.mode, 'version');
    assert.equal(await readFile(f.file, 'utf8'), '{broken configuration');
  } finally {
    await server.shutdown();
  }
});

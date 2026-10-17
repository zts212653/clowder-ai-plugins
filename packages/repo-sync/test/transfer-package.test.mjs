import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Receiver } from '../src/engine.mjs';
import { clearGithubTokens, setGithubToken } from '../src/github-auth.mjs';
import { clearIssueTokens, setIssueToken } from '../src/issue-auth.mjs';
import { git } from '../src/process.mjs';
import { configSnapshot } from '../src/recording.mjs';
import { saveTask } from '../src/task-store.mjs';
import {
  createTransfer,
  packageSummary,
  restoreTransfer,
  transferDigest,
  validateTransfer,
} from '../src/transfer-package.mjs';
import { repositories } from './fixtures.mjs';

const portable = () =>
  new Receiver({
    sourceUrl: 'https://github.com/example/core.git',
    internalUrl: 'git@codehub.example:team/core.git',
    sourceBranch: 'main',
    targetBranch: 'main',
    stateDir: join(process.cwd(), '.repo-sync-tests', 'portable'),
    internalWebUrl: 'https://codehub.example/team/core',
    mode: 'continuous',
    checks: [{ command: 'git', args: ['fsck', '--no-reflogs'] }],
    checkProfile: 'git-integrity',
    issues: { mode: 'gitlab', apiUrl: 'https://codehub.example/api/v4', projectId: 'team/core', authMode: 'session' },
  });

test('template exports reusable settings without machine paths, credentials or sync progress', async () => {
  const receiver = portable();
  const owner = 'transfer-codec-template-test';
  setGithubToken(receiver.config, 'github-private-value-not-exported', owner);
  setIssueToken(receiver.config, 'internal-private-value-not-exported', owner);
  const pkg = await createTransfer(receiver, { kind: 'template', projectId: 'default', name: '核心项目' });
  clearGithubTokens(owner);
  clearIssueTokens(owner);
  assert.equal(pkg.kind, 'template');
  assert.equal(pkg.config.stateDir, undefined);
  assert.equal(pkg.config.bindingId, undefined);
  assert.equal(pkg.config.issues.authMode, 'session');
  assert.deepEqual(pkg.files, []);
  assert.equal(pkg.objects, null);
  assert.equal(JSON.stringify(pkg).includes('private-value-not-exported'), false);
  assert.deepEqual(validateTransfer(JSON.parse(JSON.stringify(pkg))), pkg);
  assert.equal(packageSummary(pkg).bindingId, portable().config.bindingId);
});

const options = { kind: 'migration', projectId: 'default', name: '迁移项目' };
const signing = (pkg) => {
  const { packageId: _old, ...content } = pkg;
  pkg.packageId = transferDigest(content);
  return pkg;
};
async function activeFixture(mode = 'continuous') {
  const f = await repositories();
  const receiver = new Receiver({
    ...f.config,
    mode,
    internalWebUrl: 'https://codehub.example/team/core',
    checks: [{ command: 'git', args: ['fsck', '--no-reflogs'] }],
    checkProfile: 'git-integrity',
  });
  await receiver.adopt(f.u0, f.i0);
  if (mode === 'continuous') {
    await receiver.setQueue(f.plans);
    await receiver.start();
    await receiver.linkIssue('issue-71', '501', 'https://codehub.example/team/core/issues/501');
    await receiver.prepare();
    await receiver.linkPr('https://codehub.example/team/core/merge_requests/81');
  }
  const taskId = 'a'.repeat(32);
  const state = await receiver.read();
  await saveTask(
    receiver.config,
    {
      schema: 2,
      id: taskId,
      inputHash: 'b'.repeat(64),
      ownerPid: process.pid,
      projectId: 'default',
      bindingId: receiver.config.bindingId,
      configSnapshot: configSnapshot(receiver.config),
      deliveryId: state.activeId,
      action: 'prepare',
      status: 'SUCCEEDED',
      startedAt: new Date().toISOString(),
      steps: [],
    },
    true,
  );
  if (state.activeId) {
    state.deliveries[0].taskIds.push(taskId);
    await receiver.store.save(state);
  }
  return { ...f, receiver, taskId };
}

test('full transfer preserves candidate refs, SHA/Issue/PR history and task input identity across another directory', async () => {
  const f = await activeFixture();
  const before = await f.receiver.read();
  const legacyId = 'd'.repeat(32);
  await saveTask(f.receiver.config, {
    id: legacyId,
    inputHash: 'e'.repeat(64),
    ownerPid: process.pid,
    bindingId: f.receiver.config.bindingId,
    action: 'prepare',
    status: 'FAILED',
    startedAt: new Date().toISOString(),
    steps: [{ id: 'legacy-check', label: '早期检查记录', status: 'FAILED' }],
  });
  await mkdir(join(f.receiver.config.stateDir, 'checks', 'discarded'), { recursive: true });
  await writeFile(join(f.receiver.config.stateDir, 'checks', 'discarded', 'token.txt'), 'must-not-export');
  await writeFile(
    join(f.receiver.git.directory, 'config'),
    `${await readFile(join(f.receiver.git.directory, 'config'), 'utf8')}\n[credential]\n\thelper = private-helper\n`,
  );
  const pkg = await createTransfer(f.receiver, options);
  const serialized = JSON.stringify(pkg);
  assert.equal(serialized.includes('private-helper'), false);
  assert.equal(serialized.includes('must-not-export'), false);
  assert.equal(serialized.includes('writer.lock'), false);
  const summary = packageSummary(pkg);
  assert.equal(summary.taskCount, 2);
  assert.equal(summary.historyCount, 1);
  assert.equal(summary.active.prUrl, before.deliveries[0].prUrl);
  const destination = join(f.root, 'moved-private');
  const { config } = await restoreTransfer(pkg, destination, { projectId: 'c'.repeat(24) });
  const restored = new Receiver(config);
  assert.deepEqual(await restored.read(), before);
  assert.equal(
    await git(restored.git.directory, ['rev-parse', `refs/sync/deliveries/${before.activeId}`]),
    before.deliveries[0].candidate,
  );
  const task = JSON.parse(await readFile(join(destination, 'operations', `${f.taskId}.json`), 'utf8'));
  assert.equal(task.inputHash, 'b'.repeat(64));
  assert.equal(task.projectId, 'c'.repeat(24));
  assert.deepEqual(task.transferProvenance, { packageId: pkg.packageId, projectId: 'default' });
  const legacy = JSON.parse(await readFile(join(destination, 'operations', `${legacyId}.json`), 'utf8'));
  assert.equal(legacy.inputHash, 'e'.repeat(64));
  assert.equal(legacy.steps[0].label, '早期检查记录');
  assert.equal((await readFile(join(restored.git.directory, 'config'), 'utf8')).includes('private-helper'), false);
  await assert.rejects(restoreTransfer(pkg, destination), { code: 'TRANSFER_PATH_EXISTS' });
  assert.deepEqual(await restored.read(), before);
});

test('version-mode transfer restores its binding-specific object directory', async () => {
  const f = await activeFixture('version');
  const pkg = await createTransfer(f.receiver, options);
  const { config } = await restoreTransfer(pkg, join(f.root, 'version-moved'));
  const restored = new Receiver(config);
  assert.equal(await restored.git.sha('refs/sync/internal'), f.i0);
  assert.deepEqual(await restored.read(), await f.receiver.read());
});

test('unknown credentials, custom executables and custom push parameters never enter packages', async () => {
  const receiver = portable();
  receiver.config.githubToken = 'sensitive';
  await assert.rejects(createTransfer(receiver, { ...options, kind: 'template' }), { code: 'TRANSFER_CONFIG_UNKNOWN' });
  delete receiver.config.githubToken;
  receiver.config.checks = [{ command: 'private-tool', args: ['--secret', 'sensitive'] }];
  await assert.rejects(createTransfer(receiver, { ...options, kind: 'template' }), { code: 'TRANSFER_CUSTOM_COMMAND' });
  receiver.config.checks = [{ command: 'git', args: ['fsck', '--no-reflogs'] }];
  receiver.config.pullRequests = { mode: 'git', pushOptions: ['merge_request.create', 'secret=sensitive'] };
  await assert.rejects(createTransfer(receiver, { ...options, kind: 'template' }), { code: 'TRANSFER_CUSTOM_COMMAND' });
  receiver.config.pullRequests = { mode: 'command', find: { command: 'secret' } };
  await assert.rejects(createTransfer(receiver, { ...options, kind: 'template' }), { code: 'TRANSFER_CUSTOM_COMMAND' });
});

test('integrity, unsupported versions, path traversal and duplicate records fail before restoration', async () => {
  const template = await createTransfer(portable(), { ...options, kind: 'template' });
  const changed = structuredClone(template);
  changed.config.targetBranch = 'release';
  assert.throws(() => validateTransfer(changed), { code: 'TRANSFER_DIGEST_MISMATCH' });
  assert.throws(() => validateTransfer({ ...template, productVersion: 'future' }), {
    code: 'TRANSFER_VERSION_MISMATCH',
  });
  const file = { path: '../ledger.json', content: '{}', sha256: createHash('sha256').update('{}').digest('hex') };
  assert.throws(() => validateTransfer(signing({ ...template, kind: 'migration', files: [file] })), {
    code: 'TRANSFER_FILE_INVALID',
  });
  assert.throws(() => validateTransfer(signing({ ...template, kind: 'migration', files: [file, file] })), {
    code: 'TRANSFER_FILE_INVALID',
  });
  await assert.rejects(restoreTransfer(template, '../relative-path'), { code: 'TRANSFER_PATH_INVALID' });
});

test('missing records and active tasks cannot be silently omitted from a complete migration', async () => {
  const f = await activeFixture();
  const taskPath = join(f.receiver.config.stateDir, 'operations', `${f.taskId}.json`);
  const task = JSON.parse(await readFile(taskPath, 'utf8'));
  await writeFile(taskPath, JSON.stringify({ ...task, status: 'RUNNING' }));
  await assert.rejects(createTransfer(f.receiver, options), { code: 'TRANSFER_TASK_ACTIVE' });
  await writeFile(taskPath, JSON.stringify(task));
  const pkg = await createTransfer(f.receiver, options);
  const withoutTask = signing({
    ...pkg,
    files: pkg.files.filter((file) => !file.path.includes(f.taskId) && file.path !== 'operations/latest.json'),
  });
  assert.throws(() => validateTransfer(withoutTask), { code: 'TRANSFER_TASK_MISSING' });
  const badObjects = signing({ ...pkg, objects: { ...pkg.objects, data: pkg.objects.data.slice(4) } });
  assert.throws(() => validateTransfer(badObjects), { code: 'TRANSFER_OBJECT_INVALID' });
});

test('symlink state roots and destination parents are rejected without touching the target', async () => {
  const f = await activeFixture('version');
  const link = join(f.root, 'linked-state');
  await symlink(f.receiver.config.stateDir, link, process.platform === 'win32' ? 'junction' : 'dir');
  const pkg = await createTransfer(f.receiver, options);
  await assert.rejects(restoreTransfer(pkg, join(link, 'must-not-write')), { code: 'TRANSFER_SYMLINK' });
  f.receiver.config.stateDir = link;
  await assert.rejects(createTransfer(f.receiver, options), { code: 'TRANSFER_SYMLINK' });
});

import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createConnection } from '../src/connections.mjs';
import { createReceiverServer } from '../src/server.mjs';

const fields = {
  action: 'configure-repositories',
  mode: 'version',
  sourceUrl: 'https://github.com/demo/core.git',
  internalUrl: 'git@codehub.example:team/core.git',
  sourceBranch: 'main',
  targetBranch: 'main',
  internalPaths: ['internal-docs/', 'README.md'],
  mergePaths: [],
  commitClosureVerified: false,
  expectedRevision: null,
};
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'repo-sync-setup-'));
  const file = join(folder, 'private', 'config.json');
  const connection = await createConnection(file);
  return { folder, file, connection };
}
test('concurrent setup requests have one writer and preserve the winning binding', async () => {
  const { file, connection } = await fixture();
  const outcomes = await Promise.allSettled([
    connection.save(fields),
    connection.save({ ...fields, targetBranch: 'stable' }),
  ]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.ok(
    ['CONFIGURATION_BUSY', 'CONFIGURATION_CHANGED'].includes(
      outcomes.find((item) => item.status === 'rejected').reason.code,
    ),
  );
  assert.equal((await connection.current()).config.targetBranch, JSON.parse(await readFile(file, 'utf8')).targetBranch);
});
test('first use is blank and saves private configuration without performing Git or creating a ledger', async () => {
  const { file, connection } = await fixture();
  assert.equal(await connection.current(), null);
  await assert.rejects(access(file), { code: 'ENOENT' });
  await connection.save(fields);
  const receiver = await connection.current();
  assert.equal(receiver.config.mode, 'version');
  assert.equal(await receiver.status(), null);
  assert.deepEqual(receiver.config.checks, [{ command: 'git', args: ['fsck', '--no-reflogs'] }]);
  assert.equal(receiver.config.checkProfile, 'git-integrity');
  assert.equal((await createConnection(file)).describe().editable, true);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).sourceUrl, fields.sourceUrl);
  await assert.rejects(access(join(receiver.config.stateDir, 'ledger.json')), { code: 'ENOENT' });
});
test('web configuration rejects credentials and executable input, and stale edits never overwrite the file', async () => {
  const { file, connection } = await fixture();
  await assert.rejects(connection.save({ ...fields, checks: [{ command: 'arbitrary', args: [] }] }), {
    code: 'INVALID_CONFIGURATION_INPUT',
  });
  await assert.rejects(connection.save({ ...fields, sourceUrl: 'https://user:secret@github.com/demo/core' }), {
    code: 'INVALID_URL',
  });
  await assert.rejects(connection.save({ ...fields, sourceUrl: 'https://other.example/demo/core.git' }), {
    code: 'SOURCE_PLATFORM_UNSUPPORTED',
  });
  await connection.save(fields);
  const saved = await readFile(file, 'utf8');
  await assert.rejects(connection.save(fields), { code: 'CONFIGURATION_CHANGED' });
  const revision = connection.describe().revision;
  await writeFile(file, saved.replace('README.md', 'CHANGELOG.md'));
  await assert.rejects(connection.save({ ...fields, expectedRevision: revision }), { code: 'CONFIGURATION_CHANGED' });
  assert.match(await readFile(file, 'utf8'), /CHANGELOG.md/);
});
test('private paths inside repositories, broken JSON and operator-authored configs fail closed', async () => {
  const { folder } = await fixture();
  await mkdir(join(folder, 'checkout'));
  await writeFile(join(folder, 'checkout', '.git'), 'gitdir: fixture');
  await assert.rejects(createConnection(join(folder, 'checkout', 'private.json')), {
    code: 'PRIVATE_CONFIG_IN_REPOSITORY',
  });
  const file = join(folder, 'broken.json');
  await writeFile(file, '{broken private text');
  await assert.rejects(createConnection(file), { code: 'CONFIGURATION_UNREADABLE' });
  assert.equal(await readFile(file, 'utf8'), '{broken private text');
  await writeFile(file, JSON.stringify({ ...fields, stateDir: join(folder, 'state') }));
  const connection = await createConnection(file);
  assert.equal(connection.describe().editable, false);
  await assert.rejects(connection.save({ ...fields, expectedRevision: connection.describe().revision }), {
    code: 'CONFIGURATION_READ_ONLY',
  });
});
test('blank loopback workbench retains token/origin protection and rejects reception until configured', async () => {
  const { connection } = await fixture();
  const server = createReceiverServer(null, { connection });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.config, null);
    assert.equal(status.service, 'production');
    const post = (input, headers = {}) =>
      fetch(`${base}/api/action`, { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal((await post(fields)).status, 403);
    const headers = { 'X-Repo-Sync-Token': status.token };
    assert.equal((await post(fields, { ...headers, Origin: 'https://foreign.example' })).status, 403);
    assert.equal((await (await post({ action: 'prepare' }, headers)).json()).code, 'CONFIGURATION_REQUIRED');
    assert.equal((await post(fields, headers)).status, 200);
    const configured = await (await fetch(`${base}/api/status`)).json();
    assert.equal(configured.config.sourceUrl, fields.sourceUrl);
    assert.equal((await fetch(`${base}/demo/pr/${'a'.repeat(24)}`)).status, 404);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createConnection } from '../src/connections.mjs';
import { gitlabApi } from '../src/gitlab-api.mjs';
import { createReceiverServer } from '../src/server.mjs';

test('direct Issue Token is private, scoped, usable for read-only verification and cleared on service shutdown', async () => {
  let received,
    writes = 0;
  const platform = createServer((req, res) => {
    received = req.headers['private-token'];
    if (req.method !== 'GET') writes++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 5, web_url: 'https://internal.example/team/core', path_with_namespace: 'team/core' }));
  });
  await new Promise((done) => platform.listen(0, '127.0.0.1', done));
  const folder = await mkdtemp(join(tmpdir(), 'repo-sync-credentials-')),
    file = join(folder, 'config.json');
  const config = {
    sourceUrl: 'https://github.com/demo/core.git',
    internalUrl: 'git@internal.example:team/core.git',
    sourceBranch: 'main',
    targetBranch: 'main',
    stateDir: join(folder, 'state'),
    checks: [{ command: 'git', args: ['fsck'] }],
    allowLocal: true,
    internalWebUrl: 'https://internal.example/team/core',
    issues: {
      mode: 'gitlab',
      apiUrl: `http://127.0.0.1:${platform.address().port}/api/v4`,
      projectId: 'team/core',
      tokenEnv: 'REPO_SYNC_MISSING_TEST_ENV',
    },
  };
  await writeFile(file, JSON.stringify(config));
  const before = await readFile(file, 'utf8'),
    connection = await createConnection(file),
    server = createReceiverServer(await connection.current(), { connection });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`,
    initial = await (await fetch(`${base}/api/status`)).json(),
    secret = 'PRIVATE_BROWSER_TOKEN_123';
  const post = (path, input, headers = {}) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'X-Repo-Sync-Token': initial.token, ...headers },
      body: JSON.stringify(input),
    });
  try {
    const previousUndefined = process.env.undefined;
    process.env.undefined = 'SYNTHETIC_UNRELATED_ENV';
    try {
      assert.throws(
        () => gitlabApi({ ...config, issues: { ...config.issues, authMode: 'session', tokenEnv: undefined } }),
        { code: 'ISSUE_AUTH_REQUIRED' },
      );
    } finally {
      if (previousUndefined === undefined) delete process.env.undefined;
      else process.env.undefined = previousUndefined;
    }
    const denied = await post(
      '/api/issue-auth',
      { token: secret, expectedRevision: connection.describe().revision },
      { Origin: 'https://foreign.example' },
    );
    assert.equal(denied.status, 403);
    const result = await post('/api/issue-auth', { token: secret, expectedRevision: connection.describe().revision });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).authentication.available, true);
    const checked = await post('/api/issue-check', { expectedRevision: connection.describe().revision });
    assert.equal(checked.status, 200);
    assert.equal((await checked.json()).verified, true);
    assert.equal(received, secret);
    assert.equal(writes, 0);
    assert.equal(await readFile(file, 'utf8'), before);
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(JSON.stringify(status).includes(secret), false);
    assert.equal(status.operation, null);
    assert.equal((await post('/api/issue-auth', { token: secret, expectedRevision: 'stale' })).status, 409);
    const other = { ...(await connection.current()).config, stateDir: join(folder, 'other') };
    assert.throws(() => gitlabApi(other), { code: 'ISSUE_AUTH_REQUIRED' });
    const latest = (await connection.current()).config;
    await server.shutdown();
    assert.throws(() => gitlabApi(latest), { code: 'ISSUE_AUTH_REQUIRED' });
  } finally {
    await server.shutdown();
    await new Promise((done) => platform.close(done));
  }
});

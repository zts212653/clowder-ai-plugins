import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createConnection } from '../src/connections.mjs';
import { api, withGithub } from '../src/gh-api.mjs';
import {
  clearGithubTokens,
  githubAuthentication,
  markGithubVerified,
  retainGithubToken,
  setGithubToken,
} from '../src/github-auth.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { repositories } from './fixtures.mjs';

test('GitHub source auth is scoped, memory-only, revision checked and cleared by server shutdown', async (t) => {
  const saved = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  t.after(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const f = await repositories(),
    folder = await mkdtemp(join(tmpdir(), 'repo-sync-github-auth-')),
    file = join(folder, 'config.json');
  await writeFile(
    file,
    JSON.stringify({ ...f.config, configurationSource: 'workbench', sourceUrl: 'https://github.com/demo/core.git' }),
  );
  const connection = await createConnection(file),
    original = await readFile(file, 'utf8');
  let server;
  const start = async () => {
    server = createReceiverServer(null, { connection });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    return `http://127.0.0.1:${server.address().port}`;
  };
  let base = await start();
  try {
    const status = await (await fetch(`${base}/api/status`)).json();
    const input = {
      expectedRevision: status.connection.revision,
      expectedBinding: status.config.bindingId,
      token: 'SYNTHETIC_SOURCE_TOKEN',
    };
    const send = async (value) =>
      fetch(`${base}/api/github-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Repo-Sync-Token': status.token },
        body: JSON.stringify(value),
      });
    assert.equal((await send(input)).status, 200);
    const provided = await (await fetch(`${base}/api/status`)).json();
    assert.equal(provided.sourceAuthentication.available, true);
    assert.equal(JSON.stringify(provided).includes(input.token), false);
    assert.equal(await readFile(file, 'utf8'), original);
    assert.equal((await (await send({ ...input, expectedBinding: 'stale' })).json()).code, 'CONFIGURATION_CHANGED');
    assert.equal(
      (await (await send({ ...input, sourceUrl: 'https://elsewhere.example' })).json()).code,
      'CONFIGURATION_CHANGED',
    );
    assert.equal((await send({ ...input, token: '' })).status, 200);
    assert.equal((await (await fetch(`${base}/api/status`)).json()).sourceAuthentication.available, false);
    assert.equal((await send(input)).status, 200);
    await server.shutdown();
    base = await start();
    assert.equal((await (await fetch(`${base}/api/status`)).json()).sourceAuthentication.available, false);
  } finally {
    await server.shutdown();
  }
});
test('parallel source queries keep project tokens separate and rule-only migration preserves only the same source', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'repo-sync-github-scopes-')),
    owner = Symbol();
  const a = {
    stateDir: join(folder, 'a'),
    bindingId: 'a',
    sourceUrl: 'https://github.com/demo/core.git',
    internalUrl: 'internal-a',
    sourceBranch: 'main',
    targetBranch: 'main',
  };
  const b = { ...a, stateDir: join(folder, 'b'), bindingId: 'b', internalUrl: 'internal-b' };
  const migrated = { ...a, stateDir: join(folder, 'a-rules'), bindingId: 'a-rules' };
  setGithubToken(a, 'SYNTHETIC_TOKEN_A', owner);
  setGithubToken(b, 'SYNTHETIC_TOKEN_B', owner);
  t.after(() => clearGithubTokens(owner));
  retainGithubToken(a, migrated);
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    await Promise.resolve();
    seen.push(options.headers.Authorization);
    return Response.json({ node_id: 'repo' });
  });
  await Promise.all([withGithub(migrated, () => api('repos/demo/core')), withGithub(b, () => api('repos/demo/core'))]);
  assert.deepEqual(seen.sort(), ['Bearer SYNTHETIC_TOKEN_A', 'Bearer SYNTHETIC_TOKEN_B']);
  const different = { ...migrated, sourceUrl: 'https://github.com/other/core.git', bindingId: 'other' };
  retainGithubToken(migrated, different);
  assert.notEqual(githubAuthentication(different).source, 'session');
  clearGithubTokens(owner);
  assert.notEqual(githubAuthentication(migrated).source, 'session');
});

test('source auth exposes verification state without exposing the token', () => {
  const config = { stateDir: 'G:/synthetic/repo-sync', bindingId: 'verification' };
  const owner = Symbol();
  clearGithubTokens(owner);
  setGithubToken(config, 'SYNTHETIC_VERIFY_TOKEN', owner);
  assert.equal(githubAuthentication(config).available, true);
  assert.equal(githubAuthentication(config).verified, false);
  markGithubVerified(config);
  assert.equal(githubAuthentication(config).verified, true);
  clearGithubTokens(owner);
});

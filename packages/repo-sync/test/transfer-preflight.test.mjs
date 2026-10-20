import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Receiver } from '../src/engine.mjs';
import { clearGithubTokens, setGithubToken } from '../src/github-auth.mjs';
import { clearIssueTokens, setIssueToken } from '../src/issue-auth.mjs';
import { git } from '../src/process.mjs';
import { transferPreflight } from '../src/transfer-preflight.mjs';
import { repositories } from './fixtures.mjs';

const owner = 'migration-preflight-tests';
const verifySource = async () => {};
const keyed = (checks, key) => checks.find((check) => check.key === key);
async function fixture() {
  const f = await repositories();
  f.config.stateDir = await mkdtemp(join(tmpdir(), 'repo-sync-migration-preflight-'));
  f.config.checks = [{ command: 'git', args: ['fsck', '--no-reflogs'] }];
  f.config.checkProfile = 'git-integrity';
  const receiver = new Receiver(f.config);
  setGithubToken(receiver.config, 'synthetic-read-token', owner);
  return { ...f, receiver };
}
test.after(() => {
  clearGithubTokens(owner);
  clearIssueTokens(owner);
});

test('template verifies runtime, private path and both real Git remotes without adopting', async () => {
  const f = await fixture();
  const checks = await transferPreflight(f.receiver, { verifySource });
  assert.deepEqual(
    checks.map((item) => item.key),
    [
      'runtime-node',
      'runtime-git',
      'private-path',
      'binding',
      'objects',
      'repositories',
      'github-auth',
      'platform-auth',
    ],
  );
  assert.ok(
    checks.every((item) => item.status === 'PASSED'),
    JSON.stringify(checks),
  );
  assert.equal(await f.receiver.read(), null);
  assert.equal(await git(f.internal, ['rev-parse', 'main']), f.i0);
});

test('accepted baseline is proven against source ancestry and internal HEAD, with no ledger mutation', async () => {
  const f = await fixture();
  await f.receiver.adopt(f.u0, f.i0);
  const before = await readFile(join(f.config.stateDir, 'ledger.json'), 'utf8');
  const checks = await transferPreflight(f.receiver, { verifySource });
  assert.equal(keyed(checks, 'repositories')?.status, 'PASSED');
  assert.equal(await readFile(join(f.config.stateDir, 'ledger.json'), 'utf8'), before);
  await writeFile(join(f.review, 'core.txt'), 'unexpected internal change');
  await git(f.review, ['add', '.']);
  await git(f.review, ['commit', '-m', 'independent internal change']);
  await git(f.review, ['push', 'origin', 'main']);
  const failed = await transferPreflight(f.receiver, { verifySource });
  assert.equal(keyed(failed, 'repositories')?.status, 'FAILED');
  assert.equal(keyed(failed, 'repositories')?.code, 'CORE_DRIFT');
  assert.equal(await readFile(join(f.config.stateDir, 'ledger.json'), 'utf8'), before);
});

test('an invalid private destination blocks repository fetch rather than writing inside a repository', async () => {
  const f = await fixture();
  f.receiver.config.stateDir = join(f.source, 'private');
  let fetches = 0;
  f.receiver.git.fetch = async () => {
    fetches++;
    throw new Error('SHOULD_NOT_RUN_SECRET');
  };
  const checks = await transferPreflight(f.receiver, { verifySource });
  assert.equal(keyed(checks, 'private-path')?.status, 'FAILED');
  assert.equal(fetches, 0);
  assert.doesNotMatch(JSON.stringify(checks), /SHOULD_NOT_RUN_SECRET/);
});

test('a bare Git repository is rejected as a private state destination before a probe is written', async () => {
  const f = await fixture();
  const bare = await mkdtemp(join(tmpdir(), 'repo-sync-migration-bare-'));
  await git(bare, ['init', '--bare']);
  f.receiver.config.stateDir = join(bare, 'migration-private');
  const checks = await transferPreflight(f.receiver, { verifySource });
  assert.equal(keyed(checks, 'private-path')?.status, 'FAILED');
  await assert.rejects(lstat(f.receiver.config.stateDir), { code: 'ENOENT' });
});

test('only declared internal paths may advance main, without moving imported cursors', async () => {
  const f = await fixture();
  const receiver = new Receiver({ ...f.config, internalPaths: ['internal-docs/'] });
  setGithubToken(receiver.config, 'synthetic-read-token', owner);
  await receiver.adopt(f.u0, f.i0);
  const before = await readFile(join(f.config.stateDir, 'ledger.json'), 'utf8');
  await mkdir(join(f.review, 'internal-docs'));
  await writeFile(join(f.review, 'internal-docs', 'guide.md'), 'internal-only');
  await git(f.review, ['add', '.']);
  await git(f.review, ['commit', '-m', 'preserved internal documentation']);
  await git(f.review, ['push', 'origin', 'main']);
  const checks = await transferPreflight(receiver, { verifySource });
  assert.equal(keyed(checks, 'repositories')?.status, 'PASSED');
  assert.equal(await readFile(join(f.config.stateDir, 'ledger.json'), 'utf8'), before);
  assert.equal((await receiver.read()).accepted.internal, f.i0);
});

test('existing PR candidate is checked, and merged code is verified without accepting it during migration', async () => {
  const f = await fixture();
  await f.receiver.adopt(f.u0, f.i0);
  await f.receiver.setQueue(f.plans.map((plan) => ({ ...plan, issues: [] })));
  await f.receiver.start();
  await f.receiver.prepare();
  await f.receiver.linkPr('https://internal.example/team/core/pull/17');
  const delivery = (await f.receiver.status()).active;
  let checks = await transferPreflight(f.receiver, { verifySource });
  assert.equal(keyed(checks, 'repositories')?.status, 'PASSED');
  await git(f.internal, ['update-ref', '-d', `refs/heads/${delivery.branch}`]);
  checks = await transferPreflight(f.receiver, { verifySource });
  assert.equal(keyed(checks, 'repositories')?.code, 'CANDIDATE_MISSING');
  await git(f.internal, ['update-ref', `refs/heads/${delivery.branch}`, f.i0]);
  checks = await transferPreflight(f.receiver, { verifySource });
  assert.equal(keyed(checks, 'repositories')?.code, 'CANDIDATE_CONFLICT');
  await git(f.internal, ['update-ref', `refs/heads/${delivery.branch}`, delivery.candidate]);
  await f.merge(delivery);
  await git(f.internal, ['update-ref', '-d', `refs/heads/${delivery.branch}`]);
  const before = await readFile(join(f.config.stateDir, 'ledger.json'), 'utf8');
  checks = await transferPreflight(f.receiver, { verifySource });
  assert.equal(keyed(checks, 'repositories')?.status, 'PASSED', JSON.stringify(checks));
  assert.equal(await readFile(join(f.config.stateDir, 'ledger.json'), 'utf8'), before);
  assert.equal((await f.receiver.read()).accepted.internal, f.i0);
});

test('broken transferred objects block fetch and preserve the original ledger for retry', async () => {
  const f = await fixture();
  await f.receiver.adopt(f.u0, f.i0);
  const before = await readFile(join(f.config.stateDir, 'ledger.json'), 'utf8');
  const broken = join(f.receiver.git.directory, 'refs', 'broken');
  await writeFile(broken, `${'1'.repeat(40)}\n`);
  let fetches = 0;
  f.receiver.git.fetch = async () => {
    fetches++;
  };
  const checks = await transferPreflight(f.receiver, { verifySource });
  assert.equal(keyed(checks, 'objects')?.code, 'TRANSFER_OBJECTS_INCOMPLETE');
  assert.equal(keyed(checks, 'repositories')?.status, 'FAILED');
  assert.equal(fetches, 0);
  assert.equal(await readFile(join(f.config.stateDir, 'ledger.json'), 'utf8'), before);
});

test('missing API authentication and unsafe errors are actionable and retryable without raw output', async () => {
  const f = await fixture();
  const original = [process.env.GH_TOKEN, process.env.GITHUB_TOKEN];
  try {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    setGithubToken(f.receiver.config, '', owner);
    let calls = 0;
    let checks = await transferPreflight(f.receiver, {
      verifySource: async () => {
        calls++;
      },
    });
    assert.equal(keyed(checks, 'github-auth')?.code, 'GITHUB_AUTH_REQUIRED');
    assert.equal(calls, 0);
    setGithubToken(f.receiver.config, 'synthetic-read-token', owner);
    checks = await transferPreflight(f.receiver, {
      verifySource: async () => {
        throw new Error('TOKEN_PRIVATE_RAW_LOG');
      },
    });
    assert.equal(keyed(checks, 'github-auth')?.code, 'OPERATION_FAILED');
    assert.doesNotMatch(JSON.stringify(checks), /TOKEN_PRIVATE_RAW_LOG/);
    checks = await transferPreflight(f.receiver, { verifySource });
    assert.equal(keyed(checks, 'github-auth')?.status, 'PASSED');
  } finally {
    for (const [key, value] of [
      ['GH_TOKEN', original[0]],
      ['GITHUB_TOKEN', original[1]],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('internal API preflight reads only project identity and refuses a different project', async () => {
  const f = await fixture();
  const requests = [];
  let webUrl = 'https://internal.example/team/core';
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ web_url: webUrl }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const receiver = new Receiver({
      ...f.config,
      internalWebUrl: webUrl,
      issues: {
        mode: 'gitlab',
        apiUrl: `http://127.0.0.1:${server.address().port}/api/v4`,
        projectId: 'team/core',
        authMode: 'session',
      },
    });
    setGithubToken(receiver.config, 'synthetic-read-token', owner);
    setIssueToken(receiver.config, 'synthetic-internal-token', owner);
    let checks = await transferPreflight(receiver, { verifySource });
    assert.equal(keyed(checks, 'platform-auth')?.status, 'PASSED');
    assert.deepEqual(requests, [{ method: 'GET', path: '/api/v4/projects/team%2Fcore/' }]);
    webUrl = 'https://internal.example/another/repository';
    checks = await transferPreflight(receiver, { verifySource });
    assert.equal(keyed(checks, 'platform-auth')?.code, 'PLATFORM_PROJECT_MISMATCH');
    assert.ok(requests.every((request) => request.method === 'GET'));
  } finally {
    await new Promise((done) => server.close(done));
  }
});

test('default GitHub authentication checks repository identity and viewer with only read operations', async () => {
  const f = await fixture();
  const receiver = new Receiver({ ...f.config, sourceUrl: 'https://github.com/demo/core.git' });
  receiver.git.fetch = async () => ({ upstream: f.u2, internal: f.i0 });
  setGithubToken(receiver.config, 'synthetic-read-token', owner);
  const previousFetch = globalThis.fetch;
  const requests = [];
  let fullName = 'demo/core';
  globalThis.fetch = async (url, options) => {
    requests.push({ url, method: options.method, body: options.body });
    return new Response(
      JSON.stringify(
        options.method === 'POST'
          ? { data: { viewer: { login: 'synthetic-reader' } } }
          : { node_id: 'REPOSITORY_SYNTHETIC', full_name: fullName },
      ),
      { status: 200 },
    );
  };
  try {
    let checks = await transferPreflight(receiver);
    assert.equal(keyed(checks, 'github-auth')?.status, 'PASSED');
    assert.deepEqual(
      requests.map(({ url, method }) => ({ url, method })),
      [
        { url: 'https://api.github.com/repos/demo/core', method: 'GET' },
        { url: 'https://api.github.com/graphql', method: 'POST' },
      ],
    );
    assert.match(JSON.parse(requests[1].body).query, /^query /);
    assert.doesNotMatch(requests[1].body, /mutation/);
    fullName = 'another/repository';
    checks = await transferPreflight(receiver);
    assert.equal(keyed(checks, 'github-auth')?.code, 'GITHUB_REPOSITORY_MISMATCH');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('version mode does not ask for unused GitHub API credentials', async () => {
  const f = await fixture();
  const receiver = new Receiver({ ...f.config, mode: 'version' });
  let calls = 0;
  const checks = await transferPreflight(receiver, {
    verifySource: async () => {
      calls++;
    },
  });
  assert.equal(keyed(checks, 'github-auth')?.status, 'PASSED');
  assert.equal(calls, 0);
});

test('a service without Git receives a tool error and cannot attempt repository access', async () => {
  const f = await fixture();
  const previousPath = process.env.PATH;
  let fetches = 0;
  f.receiver.git.fetch = async () => {
    fetches++;
  };
  try {
    process.env.PATH = '';
    const checks = await transferPreflight(f.receiver, { verifySource });
    assert.equal(keyed(checks, 'runtime-git')?.code, 'COMMAND_NOT_FOUND');
    assert.equal(keyed(checks, 'repositories')?.status, 'FAILED');
    assert.equal(fetches, 0);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

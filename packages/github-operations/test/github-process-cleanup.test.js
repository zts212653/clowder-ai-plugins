import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { GitHubProvider } from '../src/github-provider.js';
import { ReviewTriggerReader } from '../src/review-trigger-observation.js';
import { GitHubRequestBudget } from '../src/business/infrastructure/github/request-budget.js';
import { readGitHubApiResource } from '../src/business/infrastructure/github/github-object-validator.js';

function running(pid) {
  try {
    process.kill(pid, 0);
    // An exited orphan may await OS reaping on Linux; it cannot run work.
    return !execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim().startsWith('Z');
  } catch (error) {
    if (error.code === 'ESRCH' || error.status === 1) return false;
    throw error;
  }
}

async function fixture(run, { wait = false, inheritedStdio = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'github-owned-process-'));
  const pidsFile = join(dir, 'pids');
  const helper = join(dir, 'credential-helper.cjs');
  const gh = join(dir, 'gh');
  const originalEnv = { ...process.env };
  const pids = async () => (await readFile(pidsFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(Number);
  const kill = async () => {
    for (const pid of await pids()) {
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  let watchdog;
  try {
    // No real gh, keychain, network, auth-store or user HOME is consulted.
    for (const key of Object.keys(process.env)) {
      if (/^(GH_|GITHUB_|CAT_CAFE_|COLLECTIVE_|REDIS|CALLBACK)/.test(key)) delete process.env[key];
    }
    process.env.HOME = dir;
    process.env.XDG_CONFIG_HOME = dir;
    process.env.GH_CONFIG_DIR = dir;
    process.env.PATH = `${dir}${delimiter}${originalEnv.PATH ?? ''}`;
    await writeFile(helper, `process.on('SIGTERM', () => {});
require('node:fs').appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n');
setInterval(() => {}, 1000);
`);
    await writeFile(gh, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n');
const expectedPids = fs.readFileSync(${JSON.stringify(pidsFile)}, 'utf8').trim().split('\\n').length + 1;
process.on('SIGTERM', () => {});
require('node:child_process').spawn(process.execPath, [${JSON.stringify(helper)}], { stdio: ${JSON.stringify(inheritedStdio ? 'inherit' : 'ignore')} });
const ready = setInterval(() => {
  if (fs.readFileSync(${JSON.stringify(pidsFile)}, 'utf8').trim().split('\\n').length < expectedPids) return;
  clearInterval(ready);
  if (${wait}) return;
  const endpoint = process.argv[3] || '';
  const output = endpoint.includes('/issues/comments/42/reactions') ? ''
    : endpoint.includes('/issues/comments/42') ? JSON.stringify({id:42, body:'@codex review', issue_url:'https://api.github.com/repos/owner/repo/issues/1', created_at:'2026-10-01T00:00:00Z'})
    : JSON.stringify({state:'open', closed_at:null, merged_at:null});
  process.stdout.write(output, () => process.exit(0));
}, 10);
if (${wait}) setInterval(() => {}, 1000);
`);
    await chmod(gh, 0o755);
    // Failure containment even when the implementation under test leaks a helper.
    // This timer never makes the assertion green: cleanup must finish unaided.
    let rescued = false;
    watchdog = setTimeout(() => { rescued = true; void kill(); }, 5000);
    await run({
      async ready() {
        for (let i = 0; i < 300; i++) { if ((await pids()).length >= 2) return; await delay(10); }
        throw new Error('isolated gh/helper did not start');
      },
    });
    const owned = await pids();
    assert.ok(owned.length >= 2, 'real gh and credential helper must run');
    for (let i = 0; i < 100 && owned.some(running); i++) await delay(10);
    assert.equal(rescued, false, 'test watchdog had to rescue leaked processes');
    assert.deepEqual(owned.filter(running), [], 'owned gh/credential helper survived request completion');
  } finally {
    clearTimeout(watchdog);
    await kill();
    for (const key of Object.keys(process.env)) if (!Object.hasOwn(originalEnv, key)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    await rm(dir, { recursive: true, force: true });
  }
}

const posix = process.platform === 'win32' ? 'POSIX credential subprocess lifecycle' : false;

test('default request budget reaps helper after normal gh exit', { skip: posix }, async () => {
  await fixture(async () => {
    const result = await new GitHubRequestBudget().execute(['api', '/repos/owner/repo'], { ghToken: 'isolated-fixture' });
    assert.equal(JSON.parse(result.stdout).state, 'open');
  });
});

test('default request budget abort joins gh and SIGTERM-resistant helper cleanup', { skip: posix }, async () => {
  await fixture(async ({ ready }) => {
    const controller = new AbortController();
    const pending = new GitHubRequestBudget().execute(['api', '/repos/owner/repo'], { ghToken: 'isolated-fixture', signal: controller.signal });
    const rejected = assert.rejects(pending, /cancelled fixture/);
    await ready();
    controller.abort(new Error('cancelled fixture'));
    await rejected;
  }, { wait: true });
});

test('default request budget deadline joins gh and helper cleanup', { skip: posix }, async () => {
  await fixture(async () => {
    await assert.rejects(new GitHubRequestBudget().execute(['api', '/repos/owner/repo'], { ghToken: 'isolated-fixture', timeoutMs: 1000 }), /timeout|timed out/i);
  }, { wait: true });
});

test('actual GitHubProvider default transport closes inherited helper stdio', { skip: posix }, async () => {
  await fixture(async () => {
    const provider = new GitHubProvider({ token: async () => 'isolated-fixture', log: { warn() {} } });
    assert.deepEqual(await provider.state('owner/repo', 'pr', 1, new AbortController().signal), { state: 'open', closedAt: null, mergedAt: null });
  }, { inheritedStdio: true });
});

test('actual ReviewTriggerReader default transport reaps helpers without granting coverage', { skip: posix }, async () => {
  await fixture(async () => {
    const reader = new ReviewTriggerReader({ token: async () => 'isolated-fixture' });
    try {
      const result = await reader.observe({ repoFullName: 'owner/repo', prNumber: 1, triggerCommentId: 42 });
      assert.equal(result.covered, false);
      assert.equal(result.reason, 'review_not_accepted');
    } finally { await reader.stop(); }
  });
});

test('inactive lookup boundary default also owns its credential helper', { skip: posix }, async () => {
  await fixture(async () => {
    assert.equal(JSON.parse(await readGitHubApiResource('repos/owner/repo', '.')).state, 'open');
  });
});

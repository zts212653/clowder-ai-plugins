import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.githooks', 'pre-push');

// Keep the developer's own git configuration out of the fixtures.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };

/**
 * The hook reads the allowed destination from the clone's git config, so each
 * case runs in a throwaway repo that carries (or lacks) that setting.
 */
function runPrePush({ pushRepo, args }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'git-guard-push-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd, env: gitEnv, stdio: 'ignore' });
    if (pushRepo !== undefined) {
      execFileSync('git', ['config', 'clowder.guard.pushRepo', pushRepo], { cwd, env: gitEnv, stdio: 'ignore' });
    }
    try {
      execFileSync('bash', [hook, ...args], { cwd, env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
      return { status: 0, stderr: '' };
    } catch (error) {
      return { status: error.status ?? -1, stderr: error.stderr ?? '' };
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const FORK = 'github.com/mindfn/clowder-ai-plugins';

for (const url of [
  'https://github.com/mindfn/clowder-ai-plugins.git',
  'https://github.com/mindfn/clowder-ai-plugins',
  'https://github.com/mindfn/clowder-ai-plugins/',
  'https://user:token@github.com/mindfn/clowder-ai-plugins.git',
  'https://GitHub.com/MindFn/Clowder-AI-Plugins.git',
  'git@github.com:mindfn/clowder-ai-plugins.git',
  'github.com:mindfn/clowder-ai-plugins',
  'ssh://git@github.com/mindfn/clowder-ai-plugins.git',
  'ssh://git@github.com:22/mindfn/clowder-ai-plugins.git',
]) {
  test(`the configured fork is allowed: ${url}`, () => {
    assert.equal(runPrePush({ pushRepo: FORK, args: ['fork', url] }).status, 0);
  });
}

for (const url of [
  'https://github.com/zts212653/clowder-ai-plugins.git',
  'git@github.com:zts212653/clowder-ai-plugins.git',
  // Lookalikes: the fork name as a substring is not the fork.
  'https://github.com/mindfn/clowder-ai-plugins-backup.git',
  'https://example.invalid/mindfn/clowder-ai-plugins.git',
  'https://github.com.evil.example/mindfn/clowder-ai-plugins.git',
  'https://evil.example/github.com/mindfn/clowder-ai-plugins.git',
  'https://github.com/mindfn/clowder-ai-plugins/extra.git',
  'git@evil.example:mindfn/clowder-ai-plugins.git',
  // Local paths and file URLs carry no host/owner/repo identity.
  '/tmp/mindfn/clowder-ai-plugins.git',
  'file:///tmp/mindfn/clowder-ai-plugins.git',
]) {
  test(`anything but the configured fork is rejected: ${url}`, () => {
    const result = runPrePush({ pushRepo: FORK, args: ['origin', url] });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /github\.com\/mindfn\/clowder-ai-plugins/);
  });
}

test('the allowed destination is per clone: another contributor pushes to their own fork only', () => {
  const alice = 'github.com/alice/clowder-ai-plugins';
  assert.equal(runPrePush({ pushRepo: alice, args: ['fork', 'https://github.com/alice/clowder-ai-plugins.git'] }).status, 0);
  assert.notEqual(runPrePush({ pushRepo: alice, args: ['fork', 'https://github.com/mindfn/clowder-ai-plugins.git'] }).status, 0);
});

test('a clone without a configured destination refuses every push', () => {
  const result = runPrePush({ args: ['fork', 'https://github.com/mindfn/clowder-ai-plugins.git'] });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /clowder\.guard\.pushRepo/);
});

test('an unreadable configured destination refuses every push', () => {
  const result = runPrePush({ pushRepo: 'not a repository', args: ['fork', 'https://github.com/mindfn/clowder-ai-plugins.git'] });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /clowder\.guard\.pushRepo/);
});

test('missing remote name or url fails closed', () => {
  for (const args of [[], ['fork']]) {
    const result = runPrePush({ pushRepo: FORK, args });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing remote/);
  }
});

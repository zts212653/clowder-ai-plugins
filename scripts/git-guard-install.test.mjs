import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Keep the developer's own git configuration out of the fixtures, and give
// the fixture commits an identity that does not depend on the machine.
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'guard-test',
  GIT_AUTHOR_EMAIL: 'guard-test@example.invalid',
  GIT_COMMITTER_NAME: 'guard-test',
  GIT_COMMITTER_EMAIL: 'guard-test@example.invalid',
};

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: gitEnv, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A clone laid out the way contributors work: main carries the guards and the
 * installer, and a feature branch that predates the guards is checked out in
 * its own worktree, so that worktree has no tracked hook files at all.
 */
function makeClone() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-guard-install-')));
  const main = path.join(root, 'main');
  fs.mkdirSync(main);
  const git = (...args) => {
    const result = run('git', args, main);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet', '--initial-branch', 'main');
  fs.writeFileSync(path.join(main, 'README.md'), 'fixture\n');
  git('add', 'README.md');
  git('commit', '--quiet', '-m', 'initial');
  git('branch', 'feat/old');
  fs.cpSync(path.join(repoRoot, '.githooks'), path.join(main, '.githooks'), { recursive: true });
  fs.mkdirSync(path.join(main, 'scripts'));
  fs.copyFileSync(path.join(repoRoot, 'scripts', 'install-git-guards.sh'), path.join(main, 'scripts', 'install-git-guards.sh'));
  git('add', '.githooks', 'scripts');
  git('commit', '--quiet', '-m', 'add guards');
  const oldWorktree = path.join(root, 'old');
  git('worktree', 'add', '--quiet', oldWorktree, 'feat/old');
  const upstream = path.join(root, 'upstream.git');
  assert.equal(run('git', ['init', '--quiet', '--bare', upstream], root).status, 0);
  git('remote', 'add', 'upstream', upstream);
  return {
    main,
    oldWorktree,
    upstream,
    git,
    install: (...args) => run('bash', [path.join(main, 'scripts', 'install-git-guards.sh'), ...args], main),
    config: key => run('git', ['config', '--get', key], main),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('a worktree on a branch that predates the guards still runs the push guard', t => {
  const clone = makeClone();
  t.after(clone.cleanup);
  assert.equal(fs.existsSync(path.join(clone.oldWorktree, '.githooks')), false, 'fixture: the old branch has no tracked hooks');
  const installed = clone.install('github.com/alice/clowder-ai-plugins');
  assert.equal(installed.status, 0, installed.stderr);

  const fromOld = run('git', ['push', 'upstream', 'feat/old'], clone.oldWorktree);
  assert.notEqual(fromOld.status, 0, 'the push from the old worktree must be refused');
  assert.match(fromOld.stderr, /pre-push: refusing/);
  assert.notEqual(
    run('git', ['--git-dir', clone.upstream, 'rev-parse', '--verify', '--quiet', 'refs/heads/feat/old'], clone.main).status,
    0,
    'nothing reached the refused remote',
  );

  const fromMain = run('git', ['push', 'upstream', 'main'], clone.main);
  assert.notEqual(fromMain.status, 0);
  assert.match(fromMain.stderr, /pre-push: refusing/);

  // The refusal comes from the hook, so the documented escape hatch still works.
  assert.equal(run('git', ['push', '--no-verify', 'upstream', 'feat/old'], clone.oldWorktree).status, 0);
});

test('the hooks are installed outside every checkout, in the shared git directory', t => {
  const clone = makeClone();
  t.after(clone.cleanup);
  assert.equal(clone.install('github.com/alice/clowder-ai-plugins').status, 0);
  const commonDir = fs.realpathSync(path.resolve(clone.main, clone.git('rev-parse', '--git-common-dir')));
  const hooksPath = clone.config('core.hooksPath').stdout.trim();
  assert.equal(hooksPath, path.join(commonDir, 'clowder-guard-hooks'));
  for (const name of ['pre-commit', 'pre-push', 'guard-lib.sh']) {
    const stat = fs.statSync(path.join(hooksPath, name));
    assert.ok(stat.mode & 0o100, `${name} is executable`);
  }
});

test('the installer requires an explicit push destination and installs nothing without one', t => {
  const clone = makeClone();
  t.after(clone.cleanup);
  const result = clone.install();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage/i);
  assert.notEqual(clone.config('core.hooksPath').status, 0);
  assert.notEqual(clone.config('clowder.guard.pushRepo').status, 0);
});

test('the installer rejects a destination it cannot read as host/owner/repo', t => {
  const clone = makeClone();
  t.after(clone.cleanup);
  for (const destination of ['not a repository', '/tmp/alice/clowder-ai-plugins.git', 'github.com/alice']) {
    const result = clone.install(destination);
    assert.equal(result.status, 2, destination);
  }
  assert.notEqual(clone.config('core.hooksPath').status, 0);
});

test('the installer stores the destination as a normalized identity', t => {
  const clone = makeClone();
  t.after(clone.cleanup);
  assert.equal(clone.install('git@GitHub.com:Alice/clowder-ai-plugins.git').status, 0);
  assert.equal(clone.config('clowder.guard.pushRepo').stdout.trim(), 'github.com/alice/clowder-ai-plugins');
});

test('the installer does not silently replace another hooks directory', t => {
  const clone = makeClone();
  t.after(clone.cleanup);
  clone.git('config', 'core.hooksPath', '/somewhere/else/hooks');
  const refused = clone.install('github.com/alice/clowder-ai-plugins');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--force/);
  assert.equal(clone.config('core.hooksPath').stdout.trim(), '/somewhere/else/hooks');

  assert.equal(clone.install('github.com/alice/clowder-ai-plugins', '--force').status, 0);
  assert.match(clone.config('core.hooksPath').stdout.trim(), /clowder-guard-hooks$/);
});

test('the installer upgrades the earlier relative .githooks setting without --force', t => {
  const clone = makeClone();
  t.after(clone.cleanup);
  clone.git('config', 'core.hooksPath', '.githooks');
  assert.equal(clone.install('github.com/alice/clowder-ai-plugins').status, 0);
  assert.match(clone.config('core.hooksPath').stdout.trim(), /clowder-guard-hooks$/);
});

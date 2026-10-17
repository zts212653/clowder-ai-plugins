import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { commandFailure } from '../src/command-errors.mjs';
import { safeError } from '../src/execution.mjs';
import { command } from '../src/process.mjs';

const withoutPath = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH')),
  PATH: '',
});
test('a missing GitHub CLI identifies gh, distinguishes Git login and gives Windows recovery commands', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'repo-sync-tools-'));
  await assert.rejects(
    () => command('gh', ['--version', 'SENSITIVE_ARGUMENT'], { cwd, env: withoutPath() }),
    (error) => {
      assert.equal(error.code, 'COMMAND_NOT_FOUND');
      assert.match(error.message, /GitHub CLI.*gh/);
      assert.match(error.message, /where\.exe gh/);
      assert.match(error.message, /gh --version/);
      assert.match(error.message, /Git.*账号/);
      assert.doesNotMatch(JSON.stringify(safeError(error)), /SENSITIVE_ARGUMENT|repo-sync-tools-/);
      return true;
    },
  );
});
test('a missing command working directory is never reported as a missing executable', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'repo-sync-tools-')),
    output = join(cwd, 'unexpected-write');
  await assert.rejects(
    () =>
      command(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1],"bad")', output], {
        cwd: join(cwd, 'absent'),
      }),
    { code: 'WORKING_DIRECTORY_UNAVAILABLE' },
  );
  await assert.rejects(access(output), { code: 'ENOENT' });
});
test('Git and private adapter diagnostics expose fixed labels rather than private executable names or arguments', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'repo-sync-tools-'));
  await assert.rejects(
    () => command('git', ['--version'], { cwd, env: withoutPath() }),
    (error) => {
      assert.match(error.message, /Git.*where\.exe git/);
      return true;
    },
  );
  await assert.rejects(
    () => command(join(cwd, 'PRIVATE_PROGRAM'), ['PRIVATE_ARGUMENT'], { cwd }),
    (error) => {
      assert.equal(error.code, 'COMMAND_NOT_FOUND');
      assert.match(error.message, /私有.*工具/);
      assert.doesNotMatch(JSON.stringify(safeError(error)), /PRIVATE_PROGRAM|PRIVATE_ARGUMENT|repo-sync-tools-/);
      return true;
    },
  );
});
test('GitHub CLI authentication errors are distinct from missing tools and do not expose raw output', () => {
  assert.throws(
    () => commandFailure('gh auth login; sensitive output token=PRIVATE_VALUE', 4, 'gh'),
    (error) => {
      assert.equal(error.code, 'GITHUB_AUTH_REQUIRED');
      assert.match(error.message, /gh auth login --hostname github\.com/);
      assert.doesNotMatch(JSON.stringify(safeError(error)), /PRIVATE_VALUE/);
      return true;
    },
  );
});

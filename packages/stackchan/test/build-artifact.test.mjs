import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const source = fileURLToPath(new URL('../', import.meta.url));
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test('clean builds normalize the CLI executable mode and produce identical public archives', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stackchan-build-mode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, 'packages/stackchan');
  await mkdir(fixture, { recursive: true });
  await symlink(fileURLToPath(new URL('../../../scripts/', import.meta.url)), join(root, 'scripts'), 'dir');
  for (const name of ['src', 'package.json', 'tsconfig.json', 'tsconfig.build.json']) {
    await cp(join(source, name), join(fixture, name), { recursive: true });
  }
  // Use the package's actual build, including its post-compile normalization.
  try { await cp(join(source, 'scripts'), join(fixture, 'scripts'), { recursive: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await symlink(join(source, 'node_modules'), join(fixture, 'node_modules'), 'dir');
  const cli = join(fixture, 'dist/cli.js');
  let previous;
  for (const priorMode of [null, 0o644, 0o755]) {
    await rm(join(fixture, 'dist'), { recursive: true, force: true });
    if (priorMode !== null) {
      await mkdir(join(fixture, 'dist'));
      await writeFile(cli, 'stale build');
      await chmod(cli, priorMode);
    }
    run('pnpm', ['build'], fixture);
    assert.equal((await stat(cli)).mode & 0o777, 0o755, `bin must be executable after prior mode ${priorMode}`);
    const [artifact] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json'], fixture));
    const archive = join(fixture, artifact.filename);
    const bytes = await readFile(archive);
    if (previous) assert.deepEqual(bytes, previous, 'clean build/pack must not depend on previous dist state');
    previous = bytes;
    const relocated = join(fixture, 'relocated');
    await rm(relocated, { recursive: true, force: true });
    await mkdir(relocated);
    run('tar', ['-xzf', archive, '-C', relocated], fixture);
    const extracted = join(relocated, 'package/dist/cli.js');
    assert.equal((await stat(extracted)).mode & 0o777, 0o755, 'archive bin mode');
    await access(extracted, constants.X_OK);
    // Invalid CLI input exits before reading configuration or starting services.
    const result = spawnSync(await realpath(extracted), ['--invalid'], { cwd: relocated, encoding: 'utf8' });
    assert.equal(result.error, undefined, 'execute the bin directly, not via node');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected exactly --config <absolute-path>/);
  }
});

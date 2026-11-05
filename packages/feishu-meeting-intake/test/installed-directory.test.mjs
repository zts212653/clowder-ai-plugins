import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertPublisherShrinkwrap } from '../../../scripts/catalog-package-shrinkwrap.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
function run(command, args, cwd, overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, [command, ...args, result.stdout, result.stderr].join('\n'));
  return result.stdout;
}
async function fileBytes(directory) {
  let bytes = 0;
  for (const name of await readdir(directory)) {
    const path = join(directory, name), stat = await lstat(path);
    if (stat.isDirectory()) bytes += await fileBytes(path);
    else { assert.ok(stat.isFile(), 'archive has a non-regular member'); bytes += stat.size; }
  }
  return bytes;
}

// The catalog Host owns one dependency closure. A bundled tree collides with
// activateDeclaredMcp's separately materialized, publisher-locked node_modules.
test('one meeting archive runs its module, runner and MCP through its publisher-locked dependencies', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'meeting-locked-consumer-'));
  try {
    const packs = join(temp, 'packs');
    await mkdir(packs);
    for (const name of ['plugin-contract', 'plugin-sdk', 'feishu-meeting-intake'])
      run('pnpm', ['--filter', '@clowder-ai/' + name, 'build'], root);
    const [pack] = JSON.parse(run(process.execPath,
      ['scripts/pack-publish-artifact.mjs', 'packages/feishu-meeting-intake', packs], root,
      { XDG_CACHE_HOME: join(temp, 'cache'), npm_config_cache_dir: join(temp, 'metadata'), npm_config_offline: 'true' }));
    assert.equal(pack.files.some(file => file.path.startsWith('node_modules/')), false,
      'catalog archive must not duplicate the Host-owned locked dependency tree');
    assert.equal(pack.files.some(file => file.path === 'dist/lark-cli'), false,
      'a build-host binary must never define the public archive identity');
    assert.deepEqual(pack.files.filter(file => file.path.startsWith('dist/lark-cli-runners/')).map(file => file.path), [
      'dist/lark-cli-runners/lark-cli-1.0.85-darwin-arm64.tar.gz',
      'dist/lark-cli-runners/lark-cli-1.0.85-linux-amd64.tar.gz',
    ]);
    const archive = join(packs, pack.filename), unpacked = join(temp, 'unpacked');
    await mkdir(unpacked);
    run('tar', ['-xzf', archive, '-C', unpacked], temp);
    assert.ok(await fileBytes(unpacked) <= 64 * 1024 * 1024, 'meeting archive exceeds Host uncompressed budget');
    const packed = join(unpacked, 'package');
    const pkg = JSON.parse(await readFile(join(packed, 'package.json'), 'utf8'));
    const lock = JSON.parse(await readFile(join(packed, 'npm-shrinkwrap.json'), 'utf8'));
    assertPublisherShrinkwrap(pkg, lock, { builtin: true });
    console.log(JSON.stringify({ name: 'feishu-meeting-intake', sha1: pack.shasum, integrity: pack.integrity, members: pack.files.length }));

    const host = join(temp, 'host'), home = join(temp, 'home');
    await mkdir(host);
    await mkdir(home);
    const installEnv = { HOME: home, npm_config_userconfig: join(home, '.npmrc'), npm_config_offline: 'false' };
    await writeFile(join(host, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version,
      dependencies: pkg.dependencies, optionalDependencies: pkg.optionalDependencies }));
    await cp(join(packed, 'npm-shrinkwrap.json'), join(host, 'npm-shrinkwrap.json'));
    run('npm', ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
      '--registry=https://registry.npmjs.org/', '--cache', join(temp, 'host-cache')], host, installEnv);
    for (const [dependency, version] of Object.entries(pkg.dependencies)) {
      const installed = JSON.parse(await readFile(join(host, 'node_modules', dependency, 'package.json'), 'utf8'));
      assert.equal(installed.version, version, `Host lock must install ${dependency} at its declared version`);
    }
    await assert.rejects(lstat(join(host, 'node_modules/@larksuite/cli/bin/lark-cli')), { code: 'ENOENT' },
      'Host install must not run the upstream runner download script');
    const hostPackage = join(host, 'package');
    await cp(packed, hostPackage, { recursive: true });
    await cp(new URL('./installed-consumer.mjs', import.meta.url), join(hostPackage, 'installed-journey.mjs'));
    console.log(run(process.execPath, [join(hostPackage, 'installed-journey.mjs')], host, { HOME: home, npm_config_offline: 'true' }));

    // A conventional consumer supplies only this tarball. npm consumes its
    // published shrinkwrap; no separate SDK or Contract artifact is an input.
    const consumer = join(temp, 'npm-consumer');
    await mkdir(consumer);
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
      '--registry=https://registry.npmjs.org/', '--cache', join(temp, 'consumer-cache'), archive], consumer, installEnv);
    const installed = join(consumer, 'node_modules/@clowder-ai/feishu-meeting-intake');
    await cp(new URL('./installed-consumer.mjs', import.meta.url), join(installed, 'installed-journey.mjs'));
    console.log(run(process.execPath, [join(installed, 'installed-journey.mjs')], consumer,
      { HOME: home, npm_config_offline: 'true' }));
    if (process.env.F202_MEETING_ARTIFACT_DIR) {
      await mkdir(process.env.F202_MEETING_ARTIFACT_DIR, { recursive: true });
      await cp(archive, join(process.env.F202_MEETING_ARTIFACT_DIR, pack.filename));
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

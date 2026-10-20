import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { installProductionDependencies } from '../../../scripts/pack-self-contained-artifact.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const packageRoot = join(root, 'packages/collective-connector');
function run(command, args, cwd, isolatedEnvironment) {
  assert.ok(isolatedEnvironment?.C1_ISOLATED_CONSUMER_ROOT, 'every child requires an isolated consumer environment');
  const env = { ...isolatedEnvironment };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  if (command === 'tar') env.COPYFILE_DISABLE = '1';
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, [command, ...args, result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n'));
  return result.stdout;
}

test('packed dependency closure runs the real SDK lifecycle without consumer-provided dependencies', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'collective-directory-consumer-'));
  try {
    const home = join(temporary, 'home');
    await mkdir(home);
    const testEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(?:COLLECTIVE_|REDIS|CAT_CAFE|CALLBACK|GH_|GITHUB_|NPM_TOKEN|NODE_AUTH_TOKEN|npm_config_)/i.test(key)));
    Object.assign(testEnvironment, {
      HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
      XDG_DATA_HOME: join(home, '.local/share'), npm_config_cache: join(home, '.npm'),
      npm_config_userconfig: '/dev/null', C1_ISOLATED_CONSUMER_ROOT: temporary,
      COLLECTIVE_SERVICE_HOST: '127.0.0.1', COLLECTIVE_SERVICE_PORT: '0',
      COLLECTIVE_SERVICE_DATA_DIR: join(temporary, 'unexpected-launcher-data'),
    });
    const artifacts = join(temporary, 'artifacts');
    const consumer = join(temporary, 'consumer');
    await mkdir(artifacts); await mkdir(consumer);
    const packages = ['plugin-contract', 'plugin-sdk', 'collective-connector'];
    const packed = [];
    for (const name of packages) {
      if(name==='collective-connector'){await mkdir(join(packageRoot,'dist'),{recursive:true});await writeFile(join(packageRoot,'dist','obsolete-entry.js'),'throw new Error("retired build output");');}
      run('pnpm', ['--filter', '@clowder-ai/' + name, 'build'], root, testEnvironment);
      const result = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', artifacts], join(root, 'packages', name), testEnvironment));
      assert.equal(result.length, 1);
      packed.push(join(artifacts, result[0].filename));
      console.log(JSON.stringify({ packed: result[0].filename, shasum: result[0].shasum, integrity: result[0].integrity }));
      if (name === 'collective-connector') {
        // The migrated Service/Connector business still owns Work reconsideration.
        // Only the retired Host-composition entrypoints at the dist root are banned.
        assert.equal(result[0].files.some(file => /^dist\/(?:obsolete-entry|[^/]*reconsideration[^/]*|owner-work-manual-caller[^/]*|collective-work-admission-caller[^/]*)$/.test(file.path)), false,
          'fresh build cannot republish retired root entrypoints');
        assert.ok(result[0].files.some(file => file.path === 'dist/business/connector/work-reconsideration.js'),
          'the current Connector reconsideration owner must remain packaged');
        assert.equal(result[0].files.some(file => file.path === 'dist/business/service/cli.js'), false,
          'module installation must not ship the old standalone Service launcher');
        assert.ok(result[0].files.some(file => file.path === 'plugin.yaml'));
        assert.ok(result[0].files.some(file => file.path === 'dist/plugin-entrypoint.js'));
        assert.ok(result[0].files.some(file => file.path === 'skills/collective-participation/SKILL.md'));
      }
    }
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    await writeFile(join(consumer, 'manifest.json'), JSON.stringify(parse(await readFile(join(packageRoot, 'plugin.yaml'), 'utf8'))));
    await cp(new URL('./installed-consumer-journey.mjs', import.meta.url), join(consumer, 'journey.mjs'));
    const stage = join(temporary, 'stage');
    await mkdir(stage);
    run('tar', ['-xzf', packed[2], '-C', stage], root, testEnvironment);
    const installedRoot = join(consumer, 'node_modules/@clowder-ai/collective-connector');
    await cp(join(stage, 'package'), installedRoot, { recursive: true });
    // Produce the distributed closure from its publisher lock and same-batch
    // core archives. The consumer supplies no hoisted SDK/Contract or symlinks.
    const localPacks = new Map(packages.slice(0, 2).map((name, index) => ['@clowder-ai/' + name, packed[index]]));
    await installProductionDependencies({ packageRoot: installedRoot, localPacks, env: testEnvironment });
    await rm(join(installedRoot, 'node_modules/.package-lock.json'), { force: true });
    for (const name of ['plugin-sdk', 'plugin-contract']) {
      await assert.rejects(readFile(join(consumer, 'node_modules/@clowder-ai', name, 'package.json')), { code: 'ENOENT' });
    }
    console.log(run(process.execPath, ['journey.mjs'], consumer, testEnvironment).trim());
    if (process.env.F202_COLLECTIVE_ARTIFACT_DIR) {
      const candidate = join(temporary, 'host-candidate');
      await cp(installedRoot, candidate, { recursive: true });
      const destination = process.env.F202_COLLECTIVE_ARTIFACT_DIR;
      await mkdir(destination, { recursive: true });
      for (const path of packed) await cp(path, join(destination, path.slice(path.lastIndexOf('/') + 1)));
      const archive = join(destination, 'collective-connector-self-contained.tgz');
      const release = join(temporary, 'release');
      await mkdir(release);
      await cp(candidate, join(release, 'package'), { recursive: true });
      run('tar', ['-czf', archive, '-C', release, 'package'], root, testEnvironment);
      const bytes = await readFile(archive);
      console.log(JSON.stringify({ materializedArchive: archive, sha256: createHash('sha256').update(bytes).digest('hex'),
        shasum: createHash('sha1').update(bytes).digest('hex'), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') }));
    }
    if (process.env.F202_COLLECTIVE_HOST_ROOT) {
      // The Host probe consumes an explicitly selected, unchanged distribution
      // archive. The freshly assembled directory above is not a source checkout.
      const archive = process.env.F202_COLLECTIVE_HOST_ARCHIVE;
      const digest = process.env.F202_COLLECTIVE_HOST_ARCHIVE_SHA256;
      assert.ok(archive, 'opt-in Host journey requires F202_COLLECTIVE_HOST_ARCHIVE');
      assert.match(digest ?? '', /^[a-f0-9]{64}$/, 'opt-in Host journey requires its exact archive SHA256');
      console.log(run(process.execPath, [fileURLToPath(new URL('./host-directory-journey.mjs', import.meta.url)),
        process.env.F202_COLLECTIVE_HOST_ROOT, archive, digest], root, testEnvironment).trim());
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

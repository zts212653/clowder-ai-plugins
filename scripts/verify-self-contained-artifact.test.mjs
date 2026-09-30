import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  createDeterministicArchive,
  installProductionDependencies,
  publishImmutableArtifact,
} from './pack-self-contained-artifact.mjs';
import { verifySelfContainedArchive } from './verify-self-contained-artifact.mjs';

const execFileAsync = promisify(execFile);

async function fixture(t, runtimeSource, transport = 'builtin', installedDependencies = {}, lockedVersions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'clowder-self-contained-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, 'stage');
  const packageRoot = join(stage, 'package');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await mkdir(join(packageRoot, 'node_modules'));
  const shrinkwrapPackages = { '': { name: '@clowder-ai/relocation-fixture', version: '1.0.0' } };
  for (const [name, installedVersion] of Object.entries(installedDependencies)) {
    const dependencyRoot = join(packageRoot, 'node_modules', name);
    await mkdir(dependencyRoot, { recursive: true });
    await writeFile(join(dependencyRoot, 'package.json'), JSON.stringify({
      name,
      version: installedVersion,
    }));
    shrinkwrapPackages[`node_modules/${name}`] = { version: lockedVersions[name] ?? installedVersion.trim().replace(/^[=v]+/u, '') };
  }
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@clowder-ai/relocation-fixture',
    version: '1.0.0',
    type: 'module',
    main: './dist/index.js',
  }));
  await writeFile(join(packageRoot, 'npm-shrinkwrap.json'), JSON.stringify({
    name: '@clowder-ai/relocation-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: shrinkwrapPackages,
  }));
  await writeFile(join(packageRoot, 'plugin.yaml'), [
    'runtime:',
    `  transport: ${transport}`,
    ...(runtimeSource === null ? [] : ['  entrypoint: dist/plugin-entrypoint.js']),
    '',
  ].join('\n'));
  await writeFile(join(packageRoot, 'dist/index.js'), 'export const mainWorks = true;\n');
  if (runtimeSource !== null) await writeFile(join(packageRoot, 'dist/plugin-entrypoint.js'), runtimeSource);
  const archive = join(root, 'fixture.tgz');
  const tar = spawnSync('tar', ['-czf', archive, '-C', stage, 'package'], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  return archive;
}

test('relocated builtin runtime entrypoint loads independently of package main', async (t) => {
  const archive = await fixture(t, 'export default { create() {} };\n');
  const result = await verifySelfContainedArchive(archive);
  assert.equal(result.relocation.runtimeEntrypointLoaded, true);
});

test('existing runtime entrypoint with a missing import is rejected', async (t) => {
  const archive = await fixture(t, "import 'not-installed-runtime-dependency'; export default { create() {} };\n");
  await assert.rejects(verifySelfContainedArchive(archive), /not-installed-runtime-dependency/u);
});

test('builtin runtime entrypoint without PluginModuleEntrypoint shape is rejected', async (t) => {
  const archive = await fixture(t, 'export default {};\n');
  await assert.rejects(verifySelfContainedArchive(archive), /PluginModuleEntrypoint/u);
});

test('stdio entrypoint cannot receive a misleading builtin relocation verdict', async (t) => {
  const archive = await fixture(t, 'export default { create() {} };\n', 'stdio');
  await assert.rejects(verifySelfContainedArchive(archive), /transport-specific relocation probe/u);
});

test('static package without runtime entrypoint still loads its main', async (t) => {
  const archive = await fixture(t, null);
  const result = await verifySelfContainedArchive(archive);
  assert.equal(result.relocation.runtimeEntrypointLoaded, false);
});

test('installed dependency version may carry a leading v prefix that npm normalizes away', async (t) => {
  const archive = await fixture(t, 'export default { create() {} };\n', 'builtin', {
    'upstream-v-prefixed': 'v2.1.6-beta.1',
  }, { 'upstream-v-prefixed': '2.1.6-beta.1' });
  const result = await verifySelfContainedArchive(archive);
  assert.equal(result.installedPackages, 1);
});

test('installed dependency version that differs beyond a v prefix is still rejected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clowder-self-contained-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, 'stage');
  const packageRoot = join(stage, 'package');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await mkdir(join(packageRoot, 'node_modules/upstream-v-prefixed'), { recursive: true });
  await writeFile(join(packageRoot, 'node_modules/upstream-v-prefixed/package.json'), JSON.stringify({
    name: 'upstream-v-prefixed',
    version: 'v2.1.6-beta.2',
  }));
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@clowder-ai/relocation-fixture',
    version: '1.0.0',
    type: 'module',
    main: './dist/index.js',
  }));
  await writeFile(join(packageRoot, 'npm-shrinkwrap.json'), JSON.stringify({
    name: '@clowder-ai/relocation-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: '@clowder-ai/relocation-fixture', version: '1.0.0' },
      'node_modules/upstream-v-prefixed': { version: '2.1.6-beta.1' },
    },
  }));
  await writeFile(join(packageRoot, 'plugin.yaml'), 'runtime:\n  transport: builtin\n  entrypoint: dist/plugin-entrypoint.js\n');
  await writeFile(join(packageRoot, 'dist/index.js'), 'export const mainWorks = true;\n');
  await writeFile(join(packageRoot, 'dist/plugin-entrypoint.js'), 'export default { create() {} };\n');
  const archive = join(root, 'fixture.tgz');
  const tar = spawnSync('tar', ['-czf', archive, '-C', stage, 'package'], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  await assert.rejects(verifySelfContainedArchive(archive), /version differs from shrinkwrap/u);
});

test('installed dependency version may carry a leading = that npm normalizes away', async (t) => {
  const archive = await fixture(t, 'export default { create() {} };\n', 'builtin', {
    'upstream-eq-prefixed': '=1.0.0',
  }, { 'upstream-eq-prefixed': '1.0.0' });
  const result = await verifySelfContainedArchive(archive);
  assert.equal(result.installedPackages, 1);
});

test('installed dependency version may carry surrounding whitespace that npm trims', async (t) => {
  const archive = await fixture(t, 'export default { create() {} };\n', 'builtin', {
    'upstream-padded': ' 1.0.0 ',
  }, { 'upstream-padded': '1.0.0' });
  const result = await verifySelfContainedArchive(archive);
  assert.equal(result.installedPackages, 1);
});

test('installed dependency version differing beyond a v prefix is rejected', async (t) => {
  const archive = await fixture(t, 'export default { create() {} };\n', 'builtin',
    { 'upstream-v-prefixed': 'v1.0.1' },
    { 'upstream-v-prefixed': '1.0.0' });
  await assert.rejects(verifySelfContainedArchive(archive), /version differs from shrinkwrap/u);
});

test('installed dependency version differing without any prefix is rejected', async (t) => {
  const archive = await fixture(t, 'export default { create() {} };\n', 'builtin',
    { 'upstream-mismatch': '1.0.1' },
    { 'upstream-mismatch': '1.0.0' });
  await assert.rejects(verifySelfContainedArchive(archive), /version differs from shrinkwrap/u);
});

test('content-addressed publication never replaces an existing output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clowder-self-contained-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = join(root, 'candidate.tgz');
  const destination = join(root, 'existing.tgz');
  await writeFile(candidate, 'new bytes');
  await writeFile(destination, 'old bytes');
  await assert.rejects(publishImmutableArtifact(candidate, destination), { code: 'EEXIST' });
  assert.equal(await readFile(destination, 'utf8'), 'old bytes');
  assert.deepEqual((await readdir(root)).sort(), ['candidate.tgz', 'existing.tgz']);
});

test('self-contained archive bytes ignore staging timestamps', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'clowder-self-contained-deterministic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, 'stage');
  await mkdir(join(stage, 'package/nested'), { recursive: true });
  await writeFile(join(stage, 'package/nested/value.txt'), 'stable bytes\n');
  const first = join(root, 'first.tgz');
  const second = join(root, 'second.tgz');
  await createDeterministicArchive(stage, first);
  await utimes(join(stage, 'package/nested/value.txt'), new Date(), new Date());
  await utimes(join(stage, 'package/nested'), new Date(), new Date());
  await createDeterministicArchive(stage, second);
  assert.deepEqual(await readFile(second), await readFile(first));
  const header = (await readFile(first)).subarray(0, 10);
  assert.deepEqual([...header.subarray(4, 8)], [0, 0, 0, 0], 'gzip mtime must be zero');
  assert.equal(header[9], 3, 'gzip OS field must match the Ubuntu publisher');
});

function digest(algorithm, bytes, encoding = 'hex') {
  return createHash(algorithm).update(bytes).digest(encoding);
}

async function packRegistryPackage(root, version) {
  const packageRoot = join(root, `drift-dependency-${version}`);
  const outputRoot = join(root, 'registry-packs');
  await mkdir(packageRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: 'drift-dependency',
    version,
    main: 'index.js',
  }));
  await writeFile(join(packageRoot, 'index.js'), `module.exports = ${JSON.stringify(version)};\n`);
  const output = spawnSync('npm', [
    'pack', '--json', '--ignore-scripts', '--pack-destination', outputRoot, packageRoot,
  ], { encoding: 'utf8' });
  assert.equal(output.status, 0, output.stderr);
  const [{ filename }] = JSON.parse(output.stdout);
  const archive = await readFile(join(outputRoot, filename));
  return {
    archive,
    integrity: `sha512-${digest('sha512', archive, 'base64')}`,
    shasum: digest('sha1', archive),
    version,
  };
}

async function driftRegistryFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'clowder-self-contained-registry-'));
  const releases = new Map([
    ['1.0.0', await packRegistryPackage(root, '1.0.0')],
    ['1.1.0', await packRegistryPackage(root, '1.1.0')],
  ]);
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.url === '/drift-dependency') {
      const versions = Object.fromEntries([...releases].map(([version, release]) => [version, {
        name: 'drift-dependency',
        version,
        dist: {
          integrity: release.integrity,
          shasum: release.shasum,
          tarball: `${origin}/drift-dependency/-/drift-dependency-${version}.tgz`,
        },
      }]));
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        name: 'drift-dependency',
        'dist-tags': { latest: '1.1.0' },
        versions,
      }));
      return;
    }
    const match = request.url?.match(/^\/drift-dependency\/-\/drift-dependency-(1\.0\.0|1\.1\.0)\.tgz$/u);
    if (match) {
      response.setHeader('content-type', 'application/octet-stream');
      response.end(releases.get(match[1]).archive);
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return {
    locked: releases.get('1.0.0'),
    registry: `http://127.0.0.1:${server.address().port}`,
    root,
  };
}

async function createDriftConsumer(root, registry, locked) {
  const packageRoot = join(root, 'consumer');
  await mkdir(join(packageRoot, 'dist'), { recursive: true });
  const manifest = {
    name: '@clowder-ai/drift-consumer',
    version: '1.0.0',
    type: 'module',
    main: './dist/index.js',
    dependencies: { 'drift-dependency': '^1.0.0' },
  };
  const shrinkwrap = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: manifest.name,
        version: manifest.version,
        dependencies: manifest.dependencies,
      },
      'node_modules/drift-dependency': {
        version: locked.version,
        resolved: `https://registry.npmjs.org/drift-dependency/-/drift-dependency-${locked.version}.tgz`,
        integrity: locked.integrity,
      },
    },
  };
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(packageRoot, 'npm-shrinkwrap.json'), `${JSON.stringify(shrinkwrap, null, 2)}\n`);
  await writeFile(join(packageRoot, 'plugin.yaml'), 'runtime:\n  transport: builtin\n  entrypoint: dist/plugin-entrypoint.js\n');
  await writeFile(join(packageRoot, 'dist/index.js'), 'export const mainWorks = true;\n');
  await writeFile(join(packageRoot, 'dist/plugin-entrypoint.js'), 'export default { create() {} };\n');
  return packageRoot;
}

async function archivePackage(root, packageRoot, name) {
  const stage = join(root, `${name}-stage`);
  await mkdir(stage);
  const linkResult = spawnSync('ln', ['-s', packageRoot, join(stage, 'package')], { encoding: 'utf8' });
  assert.equal(linkResult.status, 0, linkResult.stderr);
  const archive = join(root, `${name}.tgz`);
  const tar = spawnSync('tar', [
    '--exclude=package/node_modules/.package-lock.json',
    '-chzf', archive, '-C', stage, 'package',
  ], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  return archive;
}

test('production install is driven by the canonical shrinkwrap instead of newer ranged registry versions', async (t) => {
  const { locked, registry, root } = await driftRegistryFixture(t);
  const packageRoot = await createDriftConsumer(root, registry, locked);
  const manifestBytes = await readFile(join(packageRoot, 'package.json'));
  const shrinkwrapBytes = await readFile(join(packageRoot, 'npm-shrinkwrap.json'));

  await execFileAsync('npm', [
    'install', '--omit=dev', '--ignore-scripts', '--no-save', '--package-lock=false',
    '--no-bin-links', '--no-audit', '--no-fund', `--registry=${registry}`,
  ], { cwd: packageRoot });
  assert.equal(
    JSON.parse(await readFile(join(packageRoot, 'node_modules/drift-dependency/package.json'))).version,
    '1.1.0',
    'the old range-based install must demonstrate registry drift',
  );
  await assert.rejects(
    verifySelfContainedArchive(await archivePackage(root, packageRoot, 'old-range-install')),
    /version differs from shrinkwrap/u,
  );

  await rm(join(packageRoot, 'node_modules'), { recursive: true, force: true });
  await installProductionDependencies({ packageRoot, registry });
  assert.equal(
    JSON.parse(await readFile(join(packageRoot, 'node_modules/drift-dependency/package.json'))).version,
    '1.0.0',
  );
  assert.deepEqual(await readFile(join(packageRoot, 'package.json')), manifestBytes);
  assert.deepEqual(await readFile(join(packageRoot, 'npm-shrinkwrap.json')), shrinkwrapBytes);
  const verification = await verifySelfContainedArchive(
    await archivePackage(root, packageRoot, 'locked-ci-install'),
  );
  assert.equal(verification.installedPackages, 1);
});

import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
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

test('runtime projection removes only dependency declarations and retains all runtime assets', async (t) => {
  const { projectRuntimeDependencies } = await import('./pack-self-contained-artifact.mjs');
  assert.equal(typeof projectRuntimeDependencies, 'function');
  const root = await mkdtemp(join(tmpdir(), 'clowder-runtime-projection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const removed = ['node_modules/@fixture/sdk/types/index.d.ts', 'node_modules/@fixture/sdk/types/index.d.ts.map',
    'node_modules/@fixture/sdk/types/index.d.mts', 'node_modules/@fixture/sdk/types/index.d.mts.map',
    'node_modules/@fixture/sdk/node_modules/nested/index.d.cts',
    'node_modules/@fixture/sdk/node_modules/nested/index.d.cts.map'];
  const retained = ['dist/index.d.ts', 'dist/index.d.ts.map', 'package.json', 'npm-shrinkwrap.json',
    'node_modules/@fixture/sdk/package.json', 'node_modules/@fixture/sdk/lib/index.js',
    'node_modules/@fixture/sdk/es/index.js', 'node_modules/@fixture/sdk/lib/index.js.map',
    'node_modules/@fixture/sdk/types/runtime.json', 'node_modules/@fixture/sdk/types/dynamic.wasm',
    'node_modules/@fixture/sdk/certs/root.pem', 'node_modules/@fixture/sdk/LICENSE',
    'node_modules/@fixture/sdk/d.ts.json', 'node_modules/@fixture/sdk/index.d.ts.js'];
  for (const name of [...removed, ...retained]) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), name);
  }
  const proof = await projectRuntimeDependencies(root);
  assert.deepEqual(proof.removed.map(row => row.path).sort(), removed.sort());
  for (const name of retained) assert.equal(await readFile(join(root, name), 'utf8'), name);
  for (const name of removed) await assert.rejects(readFile(join(root, name)), { code: 'ENOENT' });
  assert.equal(proof.removedBytes, removed.reduce((total, name) => total + Buffer.byteLength(name), 0));
  assert.deepEqual(await projectRuntimeDependencies(root), { removed: [], removedBytes: 0 });
});

test('runtime projection brings a declaration-heavy fixture below the unchanged 32MiB admission budget', async (t) => {
  const { projectRuntimeDependencies } = await import('./pack-self-contained-artifact.mjs');
  assert.equal(typeof projectRuntimeDependencies, 'function');
  const root = await mkdtemp(join(tmpdir(), 'clowder-runtime-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'node_modules/sdk/types'), { recursive: true });
  const runtime = Buffer.alloc(25 * 1024 * 1024, 7);
  const declarations = Buffer.alloc(16 * 1024 * 1024, 32);
  await writeFile(join(root, 'node_modules/sdk/types/index.d.ts'), declarations);
  await writeFile(join(root, 'node_modules/sdk/runtime.bin'), runtime);
  assert.ok(runtime.length + declarations.length > 32 * 1024 * 1024);
  const proof = await projectRuntimeDependencies(root);
  assert.equal(proof.removedBytes, declarations.length);
  assert.deepEqual(await readFile(join(root, 'node_modules/sdk/runtime.bin')), runtime);
  assert.ok(runtime.length < 32 * 1024 * 1024);
});

test('runtime projection rejects linked dependency trees without touching the link target', async (t) => {
  const { projectRuntimeDependencies } = await import('./pack-self-contained-artifact.mjs');
  assert.equal(typeof projectRuntimeDependencies, 'function');
  const root = await mkdtemp(join(tmpdir(), 'clowder-runtime-linked-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'outside/index.d.ts'), 'must remain');
  await symlink(join(root, 'outside'), join(root, 'node_modules'));
  await assert.rejects(projectRuntimeDependencies(root), /symlink/u);
  assert.equal(await readFile(join(root, 'outside/index.d.ts'), 'utf8'), 'must remain');
});

test('projected archive still relocates with conditional runtime exports and dynamic assets', async (t) => {
  const { projectRuntimeDependencies } = await import('./pack-self-contained-artifact.mjs');
  const original = await fixture(t, 'export default { create() {} };\n', 'builtin', { sdk: '1.0.0' });
  const root = await mkdtemp(join(tmpdir(), 'clowder-runtime-relocated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('tar', ['-xzf', original, '-C', root]).status, 0);
  const packageRoot = join(root, 'package');
  const sdk = join(packageRoot, 'node_modules/sdk');
  await mkdir(join(sdk, 'lib'));
  await mkdir(join(sdk, 'types'));
  await writeFile(join(sdk, 'package.json'), JSON.stringify({ name: 'sdk', version: '1.0.0', type: 'module',
    main: './lib/index.js', types: './types/index.d.ts',
    exports: { '.': { types: './types/index.d.ts', import: './lib/index.js' } } }));
  await writeFile(join(sdk, 'types/index.d.ts'), 'export declare const value: string;\n');
  await writeFile(join(sdk, 'lib/data.json'), '{"value":"runtime asset"}');
  await writeFile(join(sdk, 'lib/root.pem'), 'runtime certificate');
  await writeFile(join(sdk, 'lib/index.js.map'), '{"version":3}');
  await writeFile(join(sdk, 'lib/index.js'), [
    "import { readFileSync } from 'node:fs';",
    "export const value = JSON.parse(readFileSync(new URL('./data.json', import.meta.url), 'utf8')).value;",
    "if (readFileSync(new URL('./root.pem', import.meta.url), 'utf8') !== 'runtime certificate') throw new Error('lost cert');",
    "if (readFileSync(new URL('./index.js.map', import.meta.url), 'utf8') !== '{\"version\":3}') throw new Error('lost runtime map');",
  ].join('\n'));
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json')));
  manifest.dependencies = { sdk: '1.0.0' };
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest));
  const lock = JSON.parse(await readFile(join(packageRoot, 'npm-shrinkwrap.json')));
  lock.packages[''].dependencies = manifest.dependencies;
  lock.packages['node_modules/sdk'].resolved = 'https://registry.npmjs.org/sdk/-/sdk-1.0.0.tgz';
  await writeFile(join(packageRoot, 'npm-shrinkwrap.json'), JSON.stringify(lock));
  await writeFile(join(packageRoot, 'dist/index.js'), "import { value } from 'sdk'; export { value };\n");
  await writeFile(join(packageRoot, 'dist/plugin-entrypoint.js'),
    "import { value } from 'sdk'; if (value !== 'runtime asset') throw new Error('bad asset'); export default { create() { return value; } };\n");
  const projection = await projectRuntimeDependencies(packageRoot);
  assert.equal(projection.removed.length, 1);
  const archive = join(root, 'runtime.tgz');
  await createDeterministicArchive(root, archive);
  const proof = await verifySelfContainedArchive(archive);
  assert.equal(proof.relocation.runtimeEntrypointLoaded, true);
  assert.equal(proof.relocation.checkedDirectDependencies, 1);
});

async function fixture(t, runtimeSource, transport = 'builtin', installedDependencies = {}, lockedVersions = {}, entryDeclaration = {}) {
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
    ...entryDeclaration,
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

async function subpathArchive(t, fault) {
  const original = await fixture(t, 'export default { create() {} };\n');
  const root = await mkdtemp(join(tmpdir(), 'clowder-subpath-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('tar', ['-xzf', original, '-C', root]).status, 0);
  const packageRoot = join(root, 'package');
  const dependencyRoot = join(packageRoot, 'node_modules/subpath-only');
  await mkdir(dependencyRoot);
  await writeFile(join(dependencyRoot, 'package.json'), JSON.stringify({
    name: 'subpath-only', version: fault === 'version' ? '1.0.1' : '1.0.0', type: 'module',
    exports: { '.': './absent-root.js', './usable': './usable.js', './missing': './missing.js' },
  }));
  await writeFile(join(dependencyRoot, 'usable.js'), 'export const value = 42;\n');
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json')));
  manifest.dependencies = { 'subpath-only': '1.0.0' };
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest));
  const lock = JSON.parse(await readFile(join(packageRoot, 'npm-shrinkwrap.json')));
  lock.packages[''].dependencies = manifest.dependencies;
  lock.packages['node_modules/subpath-only'] = {
    version: '1.0.0', resolved: 'https://registry.npmjs.org/subpath-only/-/subpath-only-1.0.0.tgz',
  };
  await writeFile(join(packageRoot, 'npm-shrinkwrap.json'), JSON.stringify(lock));
  await writeFile(join(packageRoot, 'dist/index.js'),
    `import { value } from 'subpath-only/${fault === 'main' ? 'missing' : 'usable'}'; export { value };\n`);
  await writeFile(join(packageRoot, 'dist/plugin-entrypoint.js'),
    `import { value } from 'subpath-only/${fault === 'runtime' ? 'missing' : 'usable'}'; export default { create() { return value; } };\n`);
  if (fault === 'absent') {
    await rm(dependencyRoot, { recursive: true });
    // Even an unused required dependency must be physically installed.
    await writeFile(join(packageRoot, 'dist/index.js'), 'export const ok = true;\n');
    await writeFile(join(packageRoot, 'dist/plugin-entrypoint.js'), 'export default { create() {} };\n');
  }
  if (fault === 'escape') {
    const outside = join(root, 'outside');
    await mkdir(outside);
    await rm(dependencyRoot, { recursive: true });
    await symlink(outside, dependencyRoot);
  }
  const archive = join(root, 'subpath.tgz');
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', root, 'package']).status, 0);
  return archive;
}

test('valid dependency subpaths load through real main and runtime without requiring a root API', async (t) => {
  const result = await verifySelfContainedArchive(await subpathArchive(t));
  assert.equal(result.installedPackages, 1);
  assert.equal(result.relocation.checkedDirectDependencies, 1);
  assert.equal(result.relocation.runtimeEntrypointLoaded, true);
});

for (const entry of ['main', 'runtime']) {
  test(`missing dependency subpath actually used by ${entry} is rejected`, async (t) => {
    await assert.rejects(verifySelfContainedArchive(await subpathArchive(t, entry)), /missing\.js/u);
  });
}

test('unused direct dependency absent from physical closure is rejected', async (t) => {
  await assert.rejects(verifySelfContainedArchive(await subpathArchive(t, 'absent')), /missing|UNMET|absent/u);
});

test('subpath dependency cannot use an installed version different from its lock', async (t) => {
  await assert.rejects(verifySelfContainedArchive(await subpathArchive(t, 'version')), /version differs from shrinkwrap/u);
});

test('dependency linked outside the package is rejected before extraction', async (t) => {
  await assert.rejects(verifySelfContainedArchive(await subpathArchive(t, 'escape')), /link or non-regular/u);
});

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

for (const exports of ['./dist/index.js', { '.': './dist/index.js' }, { '.': { import: './dist/index.js' } }]) {
  test(`exports-only package loads its declared root: ${JSON.stringify(exports)}`, async (t) => {
    const archive = await fixture(t, null, 'builtin', {}, {}, { main: undefined, exports });
    const result = await verifySelfContainedArchive(archive);
    assert.match(result.relocation.entry, /dist\/index\.js$/u);
  });
}

test('missing exports-only root is rejected', async (t) => {
  const archive = await fixture(t, null, 'builtin', {}, {}, { main: undefined, exports: { '.': './dist/missing.js' } });
  await assert.rejects(verifySelfContainedArchive(archive), /missing\.js/u);
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
  if (process.platform === 'darwin') {
    await execFileAsync('xattr', ['-w', 'com.clowder.archive-test', 'fixture-metadata',
      join(stage, 'package/nested/value.txt')]);
  }
  const first = join(root, 'first.tgz');
  const second = join(root, 'second.tgz');
  await createDeterministicArchive(stage, first);
  const { stdout } = await execFileAsync('tar', ['-tzf', first]);
  assert.deepEqual(stdout.trim().split('\n'), ['package/', 'package/nested/', 'package/nested/value.txt'],
    'the archive must contain exactly the staged members, without implicit AppleDouble metadata');
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

test('local candidate packs cannot replace a different frozen dependency version', async (t) => {
  const { locked, registry, root } = await driftRegistryFixture(t);
  const packageRoot = await createDriftConsumer(root, registry, locked);
  const lockBytes = await readFile(join(packageRoot, 'npm-shrinkwrap.json'));
  for (const workspaceVersion of ['1.1.0', '1.0.0']) {
    await installProductionDependencies({ packageRoot, registry,
      localPacks: new Map([['drift-dependency', join(root, 'registry-packs', `drift-dependency-${workspaceVersion}.tgz`)]]) });
    const installed = JSON.parse(await readFile(join(packageRoot, 'node_modules/drift-dependency/package.json')));
    assert.equal(installed.version, locked.version, 'only the frozen version may be materialized');
    assert.deepEqual(await readFile(join(packageRoot, 'npm-shrinkwrap.json')), lockBytes);
    await rm(join(packageRoot, 'node_modules'), { recursive: true, force: true });
  }
});

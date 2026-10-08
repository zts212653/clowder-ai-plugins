import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertArchiveBins, declaredBins, normalizePackageBins } from './package-bins.mjs';

test('bin normalization and archive admission enumerate every declared bin, including future entries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'package-bins-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = { name: 'bin-fixture', version: '1.0.0', files: ['dist'], bin: { first: './dist/first.js', future: 'dist/future.js' } };
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
  await mkdir(join(root, 'dist'));
  for (const name of ['first', 'future']) await writeFile(join(root, `dist/${name}.js`), '#!/usr/bin/env node\nprocess.stdout.write("ok");\n', { mode: 0o644 });
  const pack = () => {
    const [artifact] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    return join(root, artifact.filename);
  };
  assert.throws(() => assertArchiveBins(manifest, pack()), /0755/);
  let previous;
  for (const mode of [0o644, 0o755]) {
    for (const bin of declaredBins(manifest)) await chmod(join(root, bin), mode);
    await normalizePackageBins(root);
    for (const bin of declaredBins(manifest)) assert.equal((await stat(join(root, bin))).mode & 0o777, 0o755);
    const archive = pack();
    assertArchiveBins(manifest, archive);
    const bytes = await readFile(archive);
    if (previous) assert.deepEqual(bytes, previous);
    previous = bytes;
  }
  // A new bin cannot be silently omitted, even if previously declared bins pass.
  assert.throws(() => assertArchiveBins({ ...manifest, bin: { ...manifest.bin, missing: 'dist/missing.js' } }, pack()), /missing declared bin/);
});

test('bin paths accept npm shorthand and reject traversal, links and missing build outputs', async t => {
  assert.deepEqual(declaredBins({ bin: './dist/cli.js' }), ['dist/cli.js']);
  assert.deepEqual(declaredBins({}), []);
  for (const path of ['../outside', '/outside', 'dist/../../outside', 'dist/cli\n.js']) assert.throws(() => declaredBins({ bin: path }));
  const root = await mkdtemp(join(tmpdir(), 'package-bins-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ bin: 'cli.js' }));
  await assert.rejects(normalizePackageBins(root), /ENOENT/);
  await writeFile(join(root, 'actual.js'), 'source');
  await symlink(join(root, 'actual.js'), join(root, 'cli.js'));
  await assert.rejects(normalizePackageBins(root), /regular file/);
});

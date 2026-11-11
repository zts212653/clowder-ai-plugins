import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

async function fixture(t, broken) {
  const root = await mkdtemp(join(tmpdir(), 'clowder-pack-gate-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await Promise.all([
    'pack-gate.mjs', 'pack-publish-artifact.mjs', 'catalog-package-shrinkwrap.mjs',
    'canonical-publish-gzip.mjs', 'package-bins.mjs',
    'materialize-locked-dependencies.mjs', 'own-publish-members.mjs',
  ].map(name => copyFile(new URL(name, import.meta.url), join(root, 'scripts',
    name === 'pack-publish-artifact.mjs' ? 'actual-pack-publish-artifact.mjs' : name))));
  // Observe the real archive before the gate removes its temporary destination.
  // Loading outside the workspace must resolve the bundled dependency itself.
  await writeFile(join(root, 'scripts/pack-publish-artifact.mjs'), `
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const output = execFileSync(process.execPath, [fileURLToPath(new URL('./actual-pack-publish-artifact.mjs', import.meta.url)),
  ...process.argv.slice(2)], { encoding: 'utf8' });
const [artifact] = JSON.parse(output);
const extraction = join(process.argv[3], 'relocated');
mkdirSync(extraction);
execFileSync('tar', ['-xzf', join(process.argv[3], artifact.filename), '-C', extraction]);
const require = createRequire(import.meta.url);
const value = require(join(extraction, 'package/dist/index.js'));
writeFileSync(new URL('../artifact-proof.json', import.meta.url), JSON.stringify({ value }));
process.stdout.write(output);
`);
  await symlink(fileURLToPath(new URL('../node_modules/', import.meta.url)), join(root, 'node_modules'), 'dir');
  const app = join(root, 'packages/app');
  const dependency = join(root, '.store/dep');
  await mkdir(join(app, 'node_modules'), { recursive: true });
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0' }));
  await writeFile(join(dependency, 'index.js'), 'module.exports = 42;\n');
  await symlink(dependency, join(app, 'node_modules/dep'), 'dir');
  await writeFile(join(app, 'package.json'), JSON.stringify({
    name: '@fixture/bundled', version: '0.0.0', files: ['dist'], main: 'dist/index.js',
    dependencies: { dep: '1.0.0' }, bundledDependencies: ['dep'],
    scripts: { prepack: 'node prepare.cjs' },
  }));
  await writeFile(join(app, 'prepare.cjs'), broken ? 'process.exit(17);\n' :
    "const fs=require('node:fs');fs.mkdirSync('dist');fs.writeFileSync('dist/index.js',\"module.exports=require('dep');\\n\");\n");
  await writeFile(join(root, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'
importers:
  packages/app:
    dependencies:
      dep:
        specifier: 1.0.0
        version: 1.0.0
snapshots:
  dep@1.0.0: {}
`);
  return { root, app };
}

test('bundled gate runs prepack and materializes a real linked dependency closure',
  { skip: process.platform === 'win32' && 'canonical CI gate uses Unix npm/pnpm executables' }, async t => {
    const f = await fixture(t, false);
    const run = spawnSync(process.execPath, [join(f.root, 'scripts/pack-gate.mjs')], {
      cwd: f.root, encoding: 'utf8', timeout: 60000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(f.root, 'artifact-proof.json'), 'utf8')), { value: 42 });
    assert.match(await readFile(join(f.app, 'dist/index.js'), 'utf8'), /require\('dep'\)/u);
    assert.doesNotMatch(run.stdout, /SKIP/u);
  });

test('bundled gate rejects a failed prepack before accepting its materialized archive',
  { skip: process.platform === 'win32' && 'canonical CI gate uses Unix npm/pnpm executables' }, async t => {
    const f = await fixture(t, true);
    const run = spawnSync(process.execPath, [join(f.root, 'scripts/pack-gate.mjs')], {
      cwd: f.root, encoding: 'utf8', timeout: 60000,
    });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /FAIL @fixture\/bundled: npm pack failed \(exit 17\)/u);
    assert.doesNotMatch(run.stdout, /materialized archive/u);
  });

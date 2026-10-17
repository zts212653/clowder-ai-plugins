import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { prepareRetainedDirectoryGraph } from '../../../scripts/prepare-retained-directory-graphs.mjs';

const packageDirectory = new URL('../', import.meta.url);

async function copyProductionPackage(source, destination, ancestors = new Set()) {
  assert.ok(!ancestors.has(source), 'cyclic production graph in import fixture');
  const next = new Set([...ancestors, source]);
  await cp(source, destination, { recursive: true, dereference: true,
    filter: path => !path.slice(source.length).split('/').includes('node_modules') });
  const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  for (const name of Object.keys(metadata.dependencies ?? {})) {
    let dependency;
    try { dependency = await realpath(join(source, 'node_modules', name)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // pnpm's third-party dependencies live next to their package, rather than inside it.
      dependency = await realpath(dirname(createRequire(join(source, 'package.json')).resolve(name + '/package.json')));
    }
    await copyProductionPackage(dependency, join(destination, 'node_modules', name), next);
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, [command, ...args, result.stdout, result.stderr].filter(Boolean).join('\n'));
  return result.stdout;
}

test('packs only the public companion closure and ships the install-host CLI in the artifact', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'f247-companion-pack-'));
  try {
    const output = run(
      'node',
      ['scripts/pack-publish-artifact.mjs', 'packages/personal-chrome-companion', temporary],
      new URL('../../', packageDirectory),
    );
    const [artifact] = JSON.parse(output);
    const archive = join(temporary, artifact.filename);
    const listing = run('tar', ['-tzf', archive], temporary).split('\n');
    for (const member of [
      'package/dist/index.js',
      'package/extension/manifest.json',
      'package/native-host/native-host-cli.mjs',
      'package/README.md',
    ]) {
      assert.ok(listing.includes(member), `${member} is missing from packed artifact`);
    }
    assert.ok(listing.includes('package/native-host/install-host.mjs'));
    assert.ok(listing.includes('package/native-host/setup-host.mjs'));
    assert.ok(listing.includes('package/native-host/setup-protocol.md'));
    const packageJson = JSON.parse(await readFile(new URL('package.json', packageDirectory), 'utf8'));
    assert.equal(packageJson.private, undefined);
    assert.equal(packageJson.bin['clowder-personal-chrome-host'], 'native-host/native-host-cli.mjs');
    // Host directory installation ships only declared production edges, each with its own nested closure.
    // A flat npm consumer may accidentally hoist SDK's contract and mask a missing direct runtime dependency.
    await prepareRetainedDirectoryGraph(packageDirectory.pathname);
    const consumer = join(temporary, 'isolated-import'); await mkdir(consumer);
    run('tar', ['-xzf', archive, '-C', consumer], temporary);
    const installed = join(consumer, 'package');
    const packedJson = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
    for (const name of Object.keys(packedJson.dependencies ?? {})) {
      const physical = await realpath(new URL(`node_modules/${name}`, packageDirectory));
      await copyProductionPackage(physical, join(installed, 'node_modules', name));
    }
    run(process.execPath, ['--input-type=module', '--eval',
      "const module = await import('./dist/index.js'); if (typeof module.default?.create !== 'function') throw new Error('Packed module entrypoint unavailable'); console.log('PACKED_MODULE_IMPORTED');"], installed);
    const cliResult = spawnSync('node', [new URL('native-host/native-host-cli.mjs', packageDirectory).pathname], { cwd: new URL('.', packageDirectory).pathname, encoding: 'utf8' });
    assert.equal(cliResult.stderr.includes('required personal Chrome host configuration is missing'), true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

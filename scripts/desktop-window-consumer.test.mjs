import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, [command, ...args, result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n'));
  return result.stdout;
}

test('packed desktop window contract and SDK work in a consumer without workspace links', { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'clowder-window-consumer-'));
  const packs = join(root, 'packs');
  const consumer = join(root, 'consumer');
  await mkdir(packs);
  await mkdir(consumer);
  try {
    const artifacts = [];
    for (const name of ['plugin-contract', 'plugin-sdk', 'companion']) {
      run('pnpm', ['--filter', `@clowder-ai/${name}`, 'build'], repo);
      const output = run(process.execPath, ['scripts/pack-publish-artifact.mjs', `packages/${name}`, packs], repo);
      const [artifact] = JSON.parse(output);
      artifacts.push(join(packs, artifact.filename));
    }
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...artifacts], consumer);
    const contract = JSON.parse(await readFile(join(consumer, 'node_modules/@clowder-ai/plugin-contract/package.json'), 'utf8'));
    const sdk = JSON.parse(await readFile(join(consumer, 'node_modules/@clowder-ai/plugin-sdk/package.json'), 'utf8'));
    assert.equal(sdk.dependencies['@clowder-ai/plugin-contract'], contract.version);
    const probe = `
      import assert from 'node:assert/strict';
      import { validateManifest } from '@clowder-ai/plugin-contract';
      import companion from '@clowder-ai/companion/manifest' with { type: 'json' };
      import { createFeatureContextSession, FeatureContextRevokedError } from '@clowder-ai/plugin-sdk';
      import { createCompanionClient } from '@clowder-ai/plugin-sdk/companion';
      import { validateCompanionCommand, validateCompanionReply } from '@clowder-ai/plugin-contract';
      assert.equal(validateManifest(companion).valid, true);
      assert.equal(companion.pluginId, 'official.companion');
      assert.equal(companion.contributions[0].bridgeVersion, '1.0.0');
      const window = {
        type: 'desktop-window', id: 'pet', role: 'companion', bridgeVersion: '1.0.0',
        surface: { entrypoint: 'surface/index.html', integrity: 'sha256-' + 'A'.repeat(43) + '=' },
        presentation: { width: 320, height: 350, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true }
      };
      const manifest = { pluginId: 'dev.clowder.consumer', version: '1.0.0', contractVersion: '${contract.version}', name: 'Consumer',
        runtime: { transport: 'builtin' }, contributions: [window],
        features: [{ id: 'pet', name: 'Pet', resources: [], contributions: [{ type: window.type, id: window.id }], capabilities: ['windows.create'] }] };
      assert.equal(validateManifest(manifest).valid, true);
      assert.equal(validateManifest({ ...manifest, contributions: [{ ...window, ownerUserId: 'forged' }] }).valid, false);
      let registered = 0;
      let disposed = 0;
      const binding = { pluginInstanceId: 'fixture', featureId: 'pet', packageRevision: 'fixture', integrityEpoch: 1,
        activationRevision: 1, grantRevision: 1, grantedCapabilities: ['windows.create'], executionLease: 'host-fixture-only' };
      const session = createFeatureContextSession(binding, {
        readConfig: async () => null, readSecret: async () => '', readState: async () => null, writeState: async () => {},
        registerContribution: async (actual, input) => { assert.equal(actual, binding); assert.deepEqual(input, window); registered++; return { registrationId: 'receipt', registryRevision: 1 }; },
        disposeContribution: async () => { disposed++; }
      });
      const { type, ...input } = window;
      const first = await session.context.windows.register(input);
      assert.equal(await session.context.windows.register(input), first);
      await session.revoke();
      await assert.rejects(session.context.windows.register(input), FeatureContextRevokedError);
      assert.equal(registered, 1);
      assert.equal(disposed, 1);
      assert.equal(validateCompanionCommand({ kind: 'prepare', catId: 'forged' }), false);
      assert.equal(validateCompanionReply({ kind: 'navigation', delivery: 'requested' }), true);
      const client = createCompanionClient({ request: async command => {
        assert.deepEqual(command, { kind: 'stop' }); return { kind: 'ok' };
      }, subscribe: () => () => {} });
      assert.deepEqual(await client.stop(), { kind: 'ok' });
    `;
    await writeFile(join(consumer, 'probe.mjs'), probe);
    run(process.execPath, ['probe.mjs'], consumer);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

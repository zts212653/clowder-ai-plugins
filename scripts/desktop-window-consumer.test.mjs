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

test('packed static desktop window declarations and current SDK work without workspace links', { timeout: 240_000 }, async () => {
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
    const typeProbe = `
      import { createCompanionClient } from '@clowder-ai/plugin-sdk/companion';
      import type { CompanionSurfaceBridge } from '@clowder-ai/plugin-sdk/companion';
      import type { CompanionAppAssistState } from '@clowder-ai/plugin-contract';
      declare const bridge: CompanionSurfaceBridge;
      async function consumeAppAssist() {
        const state = await createCompanionClient(bridge).state();
        const scopeRef: string = state.appAssist.scopeRef;
        const revision: number = state.appAssist.revision;
        if (state.appAssist.status !== 'ready' || !state.appAssist.offer) return [scopeRef, revision, null];
        return [scopeRef, revision, state.appAssist.offer.appName];
      }
      // @ts-expect-error status is a closed public union.
      const invalidStatus: CompanionAppAssistState = { scopeRef: 'scope-a', revision: 1, status: 'arbitrary', offer: null };
      // @ts-expect-error revision is numeric.
      const invalidRevision: CompanionAppAssistState = { scopeRef: 'scope-a', revision: 'one', status: 'ready', offer: null };
      // @ts-expect-error a non-ready state cannot carry an offer.
      const invalidOffer: CompanionAppAssistState = { scopeRef: 'scope-a', revision: 1, status: 'suspended', offer: { offerRef: 'offer-a', appName: 'Fixture Writer' } };
      void [consumeAppAssist, invalidStatus, invalidRevision, invalidOffer];
    `;
    await writeFile(join(consumer, 'type-probe.mts'), typeProbe);
    await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true,
      },
      include: ['type-probe.mts'],
    }));
    run(process.execPath, [join(repo, 'packages/plugin-contract/node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], consumer);
    const contract = JSON.parse(await readFile(join(consumer, 'node_modules/@clowder-ai/plugin-contract/package.json'), 'utf8'));
    const sdk = JSON.parse(await readFile(join(consumer, 'node_modules/@clowder-ai/plugin-sdk/package.json'), 'utf8'));
    assert.equal(sdk.dependencies['@clowder-ai/plugin-contract'], contract.version);
    const probe = `
      import assert from 'node:assert/strict';
      import { validateManifest } from '@clowder-ai/plugin-contract';
      import companion from '@clowder-ai/companion/manifest' with { type: 'json' };
      import { activateDefinedFeature, createFeatureContextSession, definePlugin, FeatureContextRevokedError } from '@clowder-ai/plugin-sdk';
      import { createCompanionClient } from '@clowder-ai/plugin-sdk/companion';
      import { validateCompanionCommand, validateCompanionReply } from '@clowder-ai/plugin-contract';
      assert.equal(validateManifest(companion).valid, true);
      assert.equal(companion.pluginId, 'official.companion');
      assert.equal(companion.contributions[0].bridgeVersion, '1.6.0');
      assert.equal(validateCompanionCommand({ kind: 'view.layout', panel: 'menu', width: 204, height: 250 }), true);
      assert.equal(validateCompanionCommand({ kind: 'conversation.read', threadId: 'forged' }), false);
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
      let started = 0;
      let disposed = 0;
      const binding = { pluginInstanceId: 'fixture', featureId: 'pet', packageRevision: 'fixture', integrityEpoch: 1,
        activationRevision: 1, grantRevision: 1, grantedCapabilities: ['windows.create'], executionLease: 'host-fixture-only' };
      const session = createFeatureContextSession(binding, {
        readConfig: async () => null, readSecret: async () => '',
        storage: {}, tasks: {}, threads: {}, streams: { read: async function* () {} },
      });
      const plugin = definePlugin({ manifest, activate: { pet: context => {
        started++;
        assert.equal(Object.hasOwn(context, 'windows'), false);
        return { dispose() { disposed++; } };
      } } });
      assert.deepEqual(plugin.manifest.contributions, [window]);
      assert.deepEqual(plugin.manifest.features[0].contributions, [{ type: window.type, id: window.id }]);
      const active = await activateDefinedFeature(plugin, 'pet', session.context);
      assert.equal(await session.context.config.get('test'), null);
      assert.deepEqual(Object.keys(active.actions), []);
      await active.dispose();
      await active.dispose();
      await session.revoke();
      await assert.rejects(session.context.config.get('test'), FeatureContextRevokedError);
      assert.equal(started, 1);
      assert.equal(disposed, 1);
      assert.equal(validateCompanionCommand({ kind: 'prepare', catId: 'forged' }), false);
      const observation = { event: 'first_text_visible', observedAt: 1791804000123,
        callId: '11111111-1111-4111-8111-111111111111',
        reference: { kind: 'native-item', nativeItemId: 'output-item-1' } };
      assert.equal(validateCompanionCommand({ kind: 'presentation.observe', ...observation }), true);
      assert.equal(validateCompanionReply({ kind: 'navigation', delivery: 'requested' }), true);
      const companionCommands = [];
      const client = createCompanionClient({ request: async command => {
        companionCommands.push(command); return { kind: 'ok' };
      }, subscribe: () => () => {} });
      assert.deepEqual(await client.stop(), { kind: 'ok' });
      assert.deepEqual(await client.observePresentation(observation), { kind: 'ok' });
      assert.deepEqual(companionCommands, [
        { kind: 'stop' },
        { kind: 'presentation.observe', ...observation },
      ]);
    `;
    await writeFile(join(consumer, 'probe.mjs'), probe);
    run(process.execPath, ['probe.mjs'], consumer);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

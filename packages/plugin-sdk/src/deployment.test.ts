import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeploymentClient } from './deployment.js';
import { definePlugin } from './feature-context.js';
import { definePluginModule } from './module-plugin.js';
import type { ModulePluginHostShape } from './module-host.js';
const catalog = () => ({ roster: { cat: { family: 'maine-coon', available: true, lead: false } }, defaultCatId: 'cat',
  policy: { requireDifferentFamily: true, preferActiveInThread: true, preferLead: false, excludeUnavailable: true } });
test('catalog validates, snapshots and fences a response without fabricating unavailable data', async () => {
  await assert.rejects(createDeploymentClient(undefined, () => {}).getCatalog(), /unavailable/);
  let active = true; const data = catalog();
  const client = createDeploymentClient({ getCatalog: async () => data }, () => { if (!active) throw new Error('stopped'); });
  const result = await client.getCatalog(); data.roster.cat.family = 'changed';
  assert.equal(result.roster.cat!.family, 'maine-coon'); assert.equal(Object.isFrozen(result.roster.cat), true);
  await assert.rejects(createDeploymentClient({ getCatalog: async () => { active = false; return catalog(); } }, () => { if (!active) throw new Error('stopped'); }).getCatalog(), /stopped/);
  await assert.rejects(createDeploymentClient({ getCatalog: async () => ({ ...catalog(), private: 'secret' }) }, () => {}).getCatalog());
});
test('module catalog requires feature-local deployment.read and revokes at stop', async () => {
  for (const granted of [false, true]) {
    let calls = 0;
    const manifest = { pluginId: 'dev.example.deployment', version: '1.0.0', contractVersion: '0.1.0', name: 'Deployment',
      features: [{ id: 'catalog', name: 'Catalog', resources: [], contributions: [], capabilities: granted ? ['deployment.read'] : [] }],
      contributions: [], runtime: { transport: 'builtin', entrypoint: 'dist/index.js' } };
    let read!: () => Promise<unknown>;
    const module = definePluginModule(candidate => definePlugin({ manifest: candidate, activate: { catalog: ctx => {
      read = () => ctx.deployment.getCatalog(); return { actions: {} };
    } } }));
    const active = await module.create(manifest).start({ deployment: { getCatalog: async () => { calls++; return catalog(); } } } as unknown as ModulePluginHostShape);
    if (granted) assert.deepEqual(await read(), catalog()); else await assert.rejects(read(), /deployment.read/);
    assert.equal(calls, granted ? 1 : 0);
    await active.stop(); await assert.rejects(read()); assert.equal(calls, granted ? 1 : 0);
  }
});

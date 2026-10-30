import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
const read = async (file) => JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
test('package is data only and declares its configuration and bounded presets', async () => {
  const [pkg, manifest, declaration] = await Promise.all([read('package.json'), read('manifest.json'), read('agent-provider.json')]);
  assert.equal(pkg.version, manifest.version);
  assert.equal(manifest.runtime, undefined);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(manifest.configuration.find((field) => field.key === declaration.configurationKey)?.kind, 'string');
  assert.deepEqual(manifest.features.flatMap((feature) => feature.capabilities), ['plugin.config.read']);
  assert.deepEqual(JSON.parse(manifest.configuration[0].default), []);
  assert.deepEqual(declaration.presets.map((preset) => preset.id), ['dsh', 'claude', 'pi']);
  for (const preset of declaration.presets) {
    assert.ok(preset.command && !preset.command.includes('/'));
    assert.ok(Array.isArray(preset.startupArgs));
  }
});

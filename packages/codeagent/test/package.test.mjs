import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import test from 'node:test';
const read = async (file) => JSON.parse(await readFile(
  process.env.CODEAGENT_PACKAGE_DIR ? join(resolve(process.env.CODEAGENT_PACKAGE_DIR), file) : new URL(`../${file}`, import.meta.url),
  'utf8',
));

test('CodeAgent is a standalone data-only provider with an optional owner connection override', async () => {
  const [pkg, manifest, provider] = await Promise.all([read('package.json'), read('manifest.json'), read('agent-provider.json')]);
  assert.equal(pkg.version, manifest.version);
  assert.equal(manifest.pluginId, 'official.codeagent');
  assert.equal(manifest.runtime, undefined);
  assert.deepEqual(manifest.configuration.map(({ key, kind, required, default: value }) => ({ key, kind, required, value })), [
    { key: 'connection', kind: 'string', required: false, value: '{}' },
  ]);
  assert.deepEqual(manifest.features.flatMap((feature) => feature.capabilities), ['plugin.config.read']);
  assert.equal(pkg.dependencies, undefined);
  assert.deepEqual(provider, {
    id: 'codeagent',
    transport: 'acp',
    configurationKey: 'connection',
    acp: { command: 'codeagent', startupArgs: ['--acp'], permissionPolicy: 'deny' },
  });
  for (const file of ['manifest.json', 'agent-provider.json', 'README.md', 'README.en.md']) {
    assert.ok(pkg.files.includes(file));
    const path = process.env.CODEAGENT_PACKAGE_DIR
      ? join(resolve(process.env.CODEAGENT_PACKAGE_DIR), file)
      : new URL(`../${file}`, import.meta.url);
    assert.ok((await readFile(path)).byteLength > 0);
  }
});

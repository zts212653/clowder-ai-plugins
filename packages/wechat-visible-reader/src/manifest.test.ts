import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';

test('manifest and package metadata remain one exact package truth', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as {
    pluginId: string;
    version: string;
    contractVersion: string;
    description: { default: string; translations: Record<string, string> };
    contributions: Array<{ type: string; id: string; manifestPath?: string }>;
    configuration: Array<{ key: string; kind: string; actions: Array<{ action: { method: string } }> }>;
    features: Array<{ capabilities: string[] }>;
    runtime: { transport: string; entrypoint: string };
  };
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
    files: string[];
    os: string[];
  };

  assert.equal(manifest.pluginId, 'official.wechat-visible-reader');
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.contractVersion, '0.1.0');
  assert.deepEqual(packageJson.os, ['darwin']);
  assert.deepEqual(manifest.contributions, [
    { type: 'limb', id: 'wechat-visible-reader-limb', manifestPath: 'limbs/wechat-visible-reader.yml' },
  ]);
  assert.deepEqual(manifest.runtime, { transport: 'builtin', entrypoint: 'dist/plugin-entrypoint.js' });
  assert.deepEqual(manifest.features[0]?.capabilities, ['plugin.state.get', 'plugin.state.set']);
  assert.equal(manifest.configuration[0]?.kind, 'operation');
  assert.deepEqual(manifest.configuration[0]?.actions.map(({ action }) => action.method), [
    'wechat-visible-reader:arm',
    'wechat-visible-reader:disarm',
    'wechat-visible-reader:status',
  ]);
  for (const value of [manifest.description.default, ...Object.values(manifest.description.translations)]) {
    assert.ok([...value].length <= 100);
  }
  for (const member of ['README.md', 'plugin.yaml', 'assets', 'limbs', 'native', 'dist']) {
    assert.ok(packageJson.files.includes(member), `package omits ${member}`);
  }
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /short-lived authorization/i);
  assert.match(readme, /scope and expiry only/i);
  for (const capability of manifest.features[0]?.capabilities ?? []) {
    assert.ok(readme.includes(`\`${capability}\``), `README omits install-consent capability ${capability}`);
  }
  assert.match(readme, /never an operator identity/i);
  assert.match(readme, /expired or unreadable record cannot authorize a read/i);
  assert.match(readme, /currently visible in the\s+desktop WeChat/i);
});

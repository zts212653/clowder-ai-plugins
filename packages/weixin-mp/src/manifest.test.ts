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
    configuration: Array<{ key: string; kind: string; required: boolean }>;
    contributions: Array<{ type: string; id: string; manifestPath?: string; path?: string }>;
  };
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
    files: string[];
  };

  assert.equal(manifest.pluginId, 'official.weixin-mp');
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.contractVersion, '0.1.0');
  for (const value of [manifest.description.default, ...Object.values(manifest.description.translations)]) {
    assert.ok([...value].length <= 100);
  }
  assert.deepEqual(manifest.configuration, [
    { key: 'appId', label: 'App ID', kind: 'string', required: true },
    { key: 'appSecret', label: 'App Secret', kind: 'secret', required: true },
  ]);
  assert.deepEqual(manifest.contributions, [
    { type: 'limb', id: 'weixin-mp-limb', manifestPath: 'limbs/weixin-mp.yml' },
    { type: 'skill', id: 'weixin-mp-skill', path: 'skills/weixin-mp' },
  ]);
  for (const member of ['README.md', 'plugin.yaml', 'assets', 'limbs', 'skills']) {
    assert.ok(packageJson.files.includes(member), `package omits ${member}`);
  }
  const icon = await readFile(new URL('../assets/icon.svg', import.meta.url), 'utf8');
  assert.match(icon, /^<svg\b/);
  assert.doesNotMatch(icon, /<script\b|<foreignObject\b|\bon[a-z]+\s*=|(?:href|src)\s*=\s*["']https?:/i);
});

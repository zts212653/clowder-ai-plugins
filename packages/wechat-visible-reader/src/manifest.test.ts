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
  for (const value of [manifest.description.default, ...Object.values(manifest.description.translations)]) {
    assert.ok([...value].length <= 100);
  }
  for (const member of ['README.md', 'plugin.yaml', 'assets', 'limbs', 'native']) {
    assert.ok(packageJson.files.includes(member), `package omits ${member}`);
  }
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /short-lived authorization/i);
  assert.match(readme, /process-local/i);
  assert.match(readme, /currently visible in the\s+desktop WeChat/i);
});

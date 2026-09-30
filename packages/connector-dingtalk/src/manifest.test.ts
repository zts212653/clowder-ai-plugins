import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';

test('manifest preserves DingTalk config sensitivity and Host authority', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as {
    pluginId: string;
    version: string;
    contractVersion: string;
    description: { default: string; translations: Record<string, string> };
    configuration: Array<{ key: string; kind: string; required: boolean }>;
    contributions: Array<Record<string, unknown>>;
    features: Array<{ capabilities: string[] }>;
  };
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
    files: string[];
  };

  assert.equal(manifest.pluginId, 'official.connector.dingtalk');
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.contractVersion, '0.1.0');
  assert.deepEqual(manifest.configuration, [
    { key: 'appKey', label: 'App Key', kind: 'string', required: true },
    { key: 'appSecret', label: 'App Secret', kind: 'secret', required: true },
  ]);
  assert.deepEqual(manifest.contributions.map(entry => entry.type), ['identity', 'message-subscription', 'media-source']);
  assert.deepEqual(manifest.features[0]?.capabilities, [
    'plugin.config.read',
    'plugin.state.get',
    'plugin.state.set',
    'media.read',
    'message.event.subscribe',
    'messaging.send',
    'secret.read',
    'thread.listMetadata',
    'thread.write',
  ]);
  for (const value of [manifest.description.default, ...Object.values(manifest.description.translations)]) {
    assert.ok([...value].length <= 100);
  }
  for (const member of ['README.md', 'plugin.yaml', 'assets', 'npm-shrinkwrap.json']) {
    assert.ok(packageJson.files.includes(member));
  }
});

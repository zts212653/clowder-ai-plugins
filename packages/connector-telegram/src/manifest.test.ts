import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse } from 'yaml';

test('manifest keeps the Telegram token secret and binding authority Host-owned', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as {
    pluginId: string;
    version: string;
    contractVersion: string;
    configuration: Array<{ key: string; kind: string; required: boolean }>;
    contributions: Array<Record<string, unknown>>;
    features: Array<{ capabilities: string[] }>;
  };
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
    files: string[];
  };
  assert.equal(manifest.pluginId, 'official.connector.telegram');
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.contractVersion, '0.1.0');
  assert.deepEqual(manifest.configuration, [
    { key: 'botToken', label: 'Bot Token', kind: 'secret', required: true },
  ]);
  assert.deepEqual(manifest.contributions.map(entry => entry.type), ['identity', 'message-subscription', 'media-source']);
  assert.deepEqual(manifest.features[0]?.capabilities, [
    'media.read',
    'plugin.state.get',
    'plugin.state.set',
    'message.event.subscribe',
    'messaging.send',
    'secret.read',
    'thread.listMetadata',
    'thread.write',
  ]);
});

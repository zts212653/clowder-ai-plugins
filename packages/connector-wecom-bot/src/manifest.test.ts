import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

test('manifest keeps Bot Secret private and wake authority out of the package', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as {
    pluginId: string;
    contractVersion: string;
    configuration: Array<{ key: string; kind: string }>;
    contributions: Array<Record<string, unknown>>;
    features: Array<{ capabilities: string[] }>;
    runtime: Record<string, unknown>;
  };
  assert.equal(manifest.pluginId, 'official.connector.wecom-bot');
  assert.equal(manifest.contractVersion, '0.1.0');
  assert.deepEqual(manifest.configuration, [
    { key: 'botId', label: 'Bot ID', kind: 'string', required: true },
    { key: 'botSecret', label: 'Bot Secret', kind: 'secret', required: true },
  ]);
  assert.ok(manifest.contributions.some(item => item.type === 'connector' && item.id === 'wecom-bot'));
  assert.deepEqual(manifest.features[0]?.capabilities, [
    'plugin.config.read',
    'messaging.send',
    'secret.read',
  ]);
  assert.deepEqual(manifest.runtime, { transport: 'builtin', entrypoint: 'dist/plugin-entrypoint.js' });
});

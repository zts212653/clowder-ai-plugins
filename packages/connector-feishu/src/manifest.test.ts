import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

test('manifest keeps credentials secret and binding authority Host-owned', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as {
    pluginId: string;
    contractVersion: string;
    configuration: Array<{ key: string; kind: string }>;
    contributions: Array<Record<string, unknown>>;
    features: Array<{ capabilities: string[] }>;
    runtime: Record<string, unknown>;
  };
  assert.equal(manifest.pluginId, 'official.connector.feishu');
  assert.equal(manifest.contractVersion, '0.1.0');
  assert.deepEqual(manifest.configuration.filter(item => item.kind === 'secret').map(item => item.key), [
    'appSecret',
    'verificationToken',
  ]);
  assert.ok(manifest.contributions.some(item => item.type === 'connector' && item.id === 'feishu'));
  assert.ok(manifest.contributions.some(item => item.type === 'webhook' && item.id === 'feishu-events'));
  assert.deepEqual(manifest.features[0]?.capabilities, ['messaging.send']);
  assert.deepEqual(manifest.runtime, { transport: 'builtin', entrypoint: 'dist/plugin-entrypoint.js' });
});

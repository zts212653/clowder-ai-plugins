import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

test('manifest keeps credentials and connector authority in their intended domains', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as {
    pluginId: string;
    contractVersion: string;
    configuration: Array<{ key: string; kind: string }>;
    contributions: Array<{ type: string; id: string }>;
    features: Array<{ capabilities: string[] }>;
    runtime: Record<string, unknown>;
  };
  assert.equal(manifest.pluginId, 'official.connector.xiaoyi');
  assert.equal(manifest.contractVersion, '0.1.0');
  assert.deepEqual(manifest.configuration, [
    { key: 'accessKey', label: 'Access Key', kind: 'string', required: true },
    { key: 'secretKey', label: 'Secret Key', kind: 'secret', required: true },
    { key: 'agentId', label: 'Agent ID', kind: 'string', required: true },
  ]);
  assert.ok(manifest.contributions.some(item => item.type === 'message-subscription' && item.id === 'xiaoyi'));
  assert.deepEqual(manifest.features[0]?.capabilities, [
    'plugin.config.read',
    'plugin.state.get',
    'plugin.state.set',
    'message.event.subscribe',
    'messaging.send',
    'secret.read',
    'thread.listMetadata',
    'thread.write',
  ]);
  assert.deepEqual(manifest.runtime, { transport: 'builtin', entrypoint: 'dist/plugin-entrypoint.js' });
});

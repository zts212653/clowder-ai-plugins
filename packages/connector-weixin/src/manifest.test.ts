import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

test('manifest keeps the bot token secret and checkpoint authority out of package config', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as {
    pluginId: string;
    contractVersion: string;
    configuration: Array<{ key: string; kind: string }>;
    contributions: Array<Record<string, unknown>>;
    features: Array<{ capabilities: string[] }>;
    runtime: Record<string, unknown>;
  };
  assert.equal(manifest.pluginId, 'official.connector.weixin');
  assert.equal(manifest.contractVersion, '0.1.0');
  assert.deepEqual(manifest.configuration.filter(item => item.kind === 'secret').map(item => item.key), ['botToken']);
  assert.ok(manifest.contributions.some(item => item.type === 'connector' && item.id === 'weixin'));
  assert.deepEqual(manifest.features[0]?.capabilities, [
    'plugin.config.read',
    'plugin.state.get',
    'plugin.state.set',
    'messaging.send',
    'secret.read',
  ]);
  assert.equal(manifest.configuration.some(item => /cursor|checkpoint|binding/i.test(item.key)), false);
  assert.deepEqual(manifest.runtime, { transport: 'builtin', entrypoint: 'dist/plugin-entrypoint.js' });
});

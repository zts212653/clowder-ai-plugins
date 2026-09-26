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
    test: { action: { method: string } };
  };
  assert.equal(manifest.pluginId, 'official.connector.wecom-bot');
  assert.equal(manifest.contractVersion, '0.1.0');
  assert.deepEqual(manifest.configuration, [
    { key: 'botId', label: 'Bot ID', kind: 'string', required: false },
    { key: 'botSecret', label: 'Bot Secret', kind: 'secret', required: false },
    {
      key: 'wecom_validate',
      label: '验证并连接',
      kind: 'operation',
      required: false,
      target: ['botId', 'botSecret'],
      actions: [
        { id: 'validate', label: '测试并连接', render: 'button', action: { method: 'wecom-bot.validate' }, next: 'disconnect' },
        { id: 'disconnect', label: '断开连接', render: 'button', action: { method: 'wecom-bot.disconnect' }, next: 'validate' },
      ],
    },
  ]);
  assert.deepEqual(manifest.test, { action: { method: 'wecom-bot.test' } });
  assert.ok(manifest.contributions.some(item => item.type === 'message-subscription' && item.id === 'wecom-bot'));
  assert.ok(manifest.contributions.some(item => item.type === 'media-source' && item.id === 'wecom-bot-media'));
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
  assert.deepEqual(manifest.runtime, { transport: 'builtin', entrypoint: 'dist/plugin-entrypoint.js' });
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'yaml';

test('manifest keeps the bot token secret and checkpoint authority out of package config', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as {
    pluginId: string;
    contractVersion: string;
    configuration: Array<{
      key: string;
      kind: string;
      required?: boolean;
      hidden?: boolean;
      default?: unknown;
      target?: string[];
      actions?: Array<{ id: string; label: string; render: string }>;
    }>;
    contributions: Array<Record<string, unknown>>;
    features: Array<{ capabilities: string[] }>;
    runtime: Record<string, unknown>;
    test?: { action: { method: string } };
  };
  assert.equal(manifest.pluginId, 'official.connector.weixin');
  assert.equal(manifest.contractVersion, '0.1.0');
  assert.deepEqual(manifest.configuration.filter(item => item.kind === 'secret').map(item => item.key), ['botToken']);
  const botToken = manifest.configuration.find(item => item.key === 'botToken');
  assert.equal(botToken?.required, false, 'credentials written only by the QR operation must not deadlock enable');
  assert.equal(botToken?.hidden, true);
  assert.deepEqual(
    manifest.configuration.filter(item => item.kind === 'boolean' || item.key === 'voiceItemMode').map(item => item.key),
    ['voiceItemMode', 'enableUnsafeVoiceModes', 'captureInboundVoiceMedia'],
  );
  for (const voiceKey of ['voiceItemMode', 'enableUnsafeVoiceModes', 'captureInboundVoiceMedia']) {
    assert.equal(manifest.configuration.find(item => item.key === voiceKey)?.hidden, true, `${voiceKey} must be hidden`);
  }
  assert.equal(manifest.configuration.some(item => item.key === 'apiBaseUrl'), false, 'apiBaseUrl config was removed');
  assert.equal(manifest.configuration.find(item => item.key === 'voiceItemMode')?.default, undefined, 'voiceItemMode keeps unset semantics');
  const operation = manifest.configuration.find(item => item.key === 'weixin_qr_login');
  assert.equal(operation?.kind, 'operation');
  assert.deepEqual(operation?.target, ['botToken']);
  assert.deepEqual(operation?.actions?.map(({ id, label, render }) => ({ id, label, render })), [
    { id: 'qr-generate', label: '生成二维码', render: 'button' },
    { id: 'qr-status', label: '等待扫码', render: 'polling' },
    { id: 'disconnect', label: '断开连接', render: 'button' },
  ]);
  assert.equal(manifest.test?.action.method, 'weixin.test');
  assert.ok(manifest.contributions.some(item => item.type === 'message-subscription' && item.id === 'weixin'));
  assert.ok(manifest.contributions.some(item => item.type === 'media-source' && item.id === 'weixin-media'));
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
  assert.equal(manifest.configuration.some(item => /cursor|checkpoint|binding/i.test(item.key)), false);
  assert.deepEqual(manifest.runtime, { transport: 'builtin', entrypoint: 'dist/plugin-entrypoint.js' });
});

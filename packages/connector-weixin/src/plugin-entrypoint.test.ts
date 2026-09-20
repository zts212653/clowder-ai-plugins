import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { activateDefinedFeature, type FeatureContext } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import moduleEntrypoint, { createWeixinPluginModule } from './plugin-entrypoint.js';
import type { WeixinConnectorRuntime } from './runtime.js';
import type { WeixinAdapter } from './WeixinAdapter.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;

test('default export is the deterministic package module entrypoint', () => {
  assert.equal(typeof moduleEntrypoint.create, 'function');
  assert.equal(moduleEntrypoint.create(manifest).manifest.pluginId, 'official.connector.weixin');
});

test('module binds Host-owned state and exposes only its declared outbound action', async () => {
  const writes: unknown[] = [];
  const replies: unknown[] = [];
  let stops = 0;
  const outbound = {
    async sendReply(...args: unknown[]) { replies.push(args); },
    async sendMedia() {},
  } as unknown as WeixinAdapter;
  const entrypoint = createWeixinPluginModule((options) => ({
    outbound,
    async start() {
      await options.state.save({ getUpdatesBuf: 'cursor' });
    },
    async stop() { stops += 1; },
  } as WeixinConnectorRuntime<WeixinAdapter>));
  const values: Record<string, unknown> = {
    voiceItemMode: 'minimal',
    enableUnsafeVoiceModes: false,
    captureInboundVoiceMedia: false,
  };
  const context = {
    featureId: 'weixin-messaging',
    config: { get: async (key: string) => values[key] },
    secrets: { get: async () => 'token' },
    state: {
      get: async () => null,
      set: async (key: string, value: unknown) => { writes.push([key, value]); },
    },
    connectors: { deliver: async () => undefined },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as FeatureContext;

  const active = await activateDefinedFeature(entrypoint.create(manifest), 'weixin-messaging', context);
  await active.actions['weixin.outbound']?.({
    deliveryId: 'delivery-1',
    externalConversationId: 'chat-1',
    presentation: { header: '砚砚', body: 'hello', origin: 'agent' },
  });
  await active.dispose();
  assert.deepEqual(writes, [['provider-session', { getUpdatesBuf: 'cursor' }]]);
  assert.deepEqual(replies, [['chat-1', '砚砚\n\nhello']]);
  assert.equal(stops, 1);
});

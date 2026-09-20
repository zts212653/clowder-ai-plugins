import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { activateDefinedFeature, type FeatureContext } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import moduleEntrypoint, { createWeComBotPluginModule } from './plugin-entrypoint.js';
import type { WeComBotConnectorRuntime } from './runtime.js';
import type { WeComBotAdapter } from './WeComBotAdapter.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;
const delivery = {
  deliveryId: 'delivery-1',
  externalConversationId: 'chat-1',
  presentation: { header: '砚砚', body: 'hello', origin: 'agent' },
};

test('default export is the deterministic package module entrypoint', () => {
  assert.equal(typeof moduleEntrypoint.create, 'function');
  assert.equal(moduleEntrypoint.create(manifest).manifest.pluginId, 'official.connector.wecom-bot');
});

test('module exposes the declared outbound action and disposes the runtime once', async () => {
  const sent: unknown[] = [];
  let starts = 0;
  let stops = 0;
  const outbound = {
    async sendFormattedReply(...args: unknown[]) { sent.push(args); },
    async sendMedia() {},
    async sendReply() {},
  } as unknown as WeComBotAdapter;
  const entrypoint = createWeComBotPluginModule((options) => {
    assert.deepEqual(options.config, { botId: 'bot', botSecret: 'secret' });
    return {
      outbound,
      async start() { starts += 1; },
      async stop() { stops += 1; },
    } as WeComBotConnectorRuntime<WeComBotAdapter>;
  });
  const context = {
    featureId: 'wecom-bot-messaging',
    config: { get: async () => 'bot' },
    secrets: { get: async () => 'secret' },
    connectors: { deliver: async () => undefined },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as FeatureContext;

  const active = await activateDefinedFeature(entrypoint.create(manifest), 'wecom-bot-messaging', context);
  await active.actions['wecom-bot.outbound']?.(delivery);
  await Promise.all([active.dispose(), active.dispose()]);
  assert.equal(starts, 1);
  assert.equal(stops, 1);
  assert.equal(sent.length, 1);
});

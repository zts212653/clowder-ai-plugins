import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { activateDefinedFeature, type FeatureContext } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import moduleEntrypoint, { createXiaoyiPluginModule } from './plugin-entrypoint.js';
import type { XiaoyiConnectorRuntime } from './runtime.js';
import type { XiaoyiAdapter } from './XiaoyiAdapter.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;

test('default export is the deterministic package module entrypoint', () => {
  assert.equal(typeof moduleEntrypoint.create, 'function');
  assert.equal(moduleEntrypoint.create(manifest).manifest.pluginId, 'official.connector.xiaoyi');
});

test('module settles the provider task after the declared outbound action completes', async () => {
  const events: unknown[] = [];
  const outbound = {
    async sendReply(...args: unknown[]) { events.push(['reply', ...args]); },
    async onDeliveryBatchDone(...args: unknown[]) { events.push(['done', ...args]); },
  } as unknown as XiaoyiAdapter;
  const entrypoint = createXiaoyiPluginModule((options) => {
    assert.deepEqual(options.config, { accessKey: 'ak', secretKey: 'sk', agentId: 'agent' });
    return { outbound, async start() {}, async stop() {} } as XiaoyiConnectorRuntime<XiaoyiAdapter>;
  });
  const values: Record<string, unknown> = { accessKey: 'ak', agentId: 'agent' };
  const context = {
    featureId: 'xiaoyi-messaging',
    config: { get: async (key: string) => values[key] },
    secrets: { get: async () => 'sk' },
    connectors: { deliver: async () => undefined },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as FeatureContext;

  const active = await activateDefinedFeature(entrypoint.create(manifest), 'xiaoyi-messaging', context);
  await active.actions['xiaoyi.outbound']?.({
    deliveryId: 'delivery-1',
    externalConversationId: 'agent:session',
    presentation: { header: '砚砚', body: 'hello', origin: 'agent' },
  });
  assert.deepEqual(events, [
    ['reply', 'agent:session', '砚砚\n\nhello'],
    ['done', 'agent:session', true],
  ]);
});

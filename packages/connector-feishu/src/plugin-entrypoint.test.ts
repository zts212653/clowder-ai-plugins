import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { activateDefinedFeature, type FeatureContext } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import moduleEntrypoint, { createFeishuPluginModule } from './plugin-entrypoint.js';
import type { FeishuConnectorRuntime } from './runtime.js';
import type { FeishuAdapter } from './FeishuAdapter.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;

test('default export is the deterministic package module entrypoint', () => {
  assert.equal(typeof moduleEntrypoint.create, 'function');
  assert.equal(moduleEntrypoint.create(manifest).manifest.pluginId, 'official.connector.feishu');
});

test('module exposes both manifest-declared connector and webhook actions', async () => {
  const outbound = {
    async sendFormattedReply() {}, async sendMedia() {}, async sendReply() {},
  } as unknown as FeishuAdapter;
  const entrypoint = createFeishuPluginModule(() => ({
    outbound,
    async start() {}, async stop() {},
    async handleWebhook() { return { kind: 'skipped', reason: 'test' }; },
  } as FeishuConnectorRuntime<FeishuAdapter>));
  const config: Record<string, unknown> = { appId: 'app', connectionMode: 'webhook' };
  const secrets: Record<string, string> = { appSecret: 'secret', verificationToken: '' };
  const context = {
    featureId: 'feishu-messaging',
    config: { get: async (key: string) => config[key] },
    secrets: { get: async (key: string) => secrets[key]! },
    connectors: { deliver: async () => undefined },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as FeatureContext;
  const active = await activateDefinedFeature(entrypoint.create(manifest), 'feishu-messaging', context);
  assert.deepEqual(Object.keys(active.actions).sort(), ['feishu.outbound', 'feishu.webhook']);
  assert.deepEqual(await active.actions['feishu.webhook']?.({}), { kind: 'skipped', reason: 'test' });
});

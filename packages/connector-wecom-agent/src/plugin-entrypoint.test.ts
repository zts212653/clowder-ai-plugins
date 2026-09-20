import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { activateDefinedFeature, type FeatureContext } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import moduleEntrypoint, { createWeComAgentPluginModule } from './plugin-entrypoint.js';
import type { WeComAgentConnectorRuntime } from './runtime.js';
import type { WeComAgentAdapter } from './WeComAgentAdapter.js';

const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;

test('default export is the deterministic package module entrypoint', () => {
  assert.equal(typeof moduleEntrypoint.create, 'function');
  assert.equal(moduleEntrypoint.create(manifest).manifest.pluginId, 'official.connector.wecom-agent');
});

test('module exposes both manifest-declared connector and webhook actions', async () => {
  const outbound = {
    async sendFormattedReply() {}, async sendMedia() {}, async sendReply() {},
  } as unknown as WeComAgentAdapter;
  const entrypoint = createWeComAgentPluginModule(() => ({
    outbound,
    async start() {}, async stop() {},
    async handleWebhook() { return { kind: 'skipped', reason: 'test' }; },
  } as WeComAgentConnectorRuntime<WeComAgentAdapter>));
  const config: Record<string, unknown> = { corpId: 'corp', agentId: 'agent' };
  const secrets: Record<string, string> = { agentSecret: 'secret', callbackToken: 'token', encodingAesKey: 'aes' };
  const context = {
    featureId: 'wecom-agent-messaging',
    config: { get: async (key: string) => config[key] },
    secrets: { get: async (key: string) => secrets[key]! },
    connectors: { deliver: async () => undefined },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as unknown as FeatureContext;
  const active = await activateDefinedFeature(entrypoint.create(manifest), 'wecom-agent-messaging', context);
  assert.deepEqual(Object.keys(active.actions).sort(), ['wecom-agent.outbound', 'wecom-agent.webhook']);
  assert.deepEqual(await active.actions['wecom-agent.webhook']?.({}), { kind: 'skipped', reason: 'test' });
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';

const factories = { dingtalk: 'createDingTalkPluginModule', feishu: 'createFeishuPluginModule',
  telegram: 'createTelegramPluginModule', 'wecom-agent': 'createWeComAgentPluginModule',
  'wecom-bot': 'createWeComBotPluginModule', weixin: 'createWeixinPluginModule', xiaoyi: 'createXiaoyiPluginModule' };
const groupConnectors = new Set(['dingtalk', 'feishu', 'wecom-bot']);
const packedRoots = process.env.CLOWDER_CONNECTOR_PACKED_ROOTS
  ? JSON.parse(process.env.CLOWDER_CONNECTOR_PACKED_ROOTS) : undefined;

for (const [name, factory] of Object.entries(factories)) {
  if (packedRoots && !packedRoots[name]) continue;
  const manifestPath = packedRoots ? join(packedRoots[name], 'plugin.yaml')
    : new URL(`../packages/connector-${name}/plugin.yaml`, import.meta.url);
  test(`${name}: original setup has no permission import/read/apply or JSON prerequisite`, async () => {
    const manifest = parse(await readFile(manifestPath, 'utf8'));
    assert.deepEqual(manifest.configuration.filter(field => /legacy_permissions|connector_permissions|permission.*Json|permissionRevision/.test(field.key)), []);
    if (!groupConnectors.has(name)) assert.deepEqual(manifest.configuration.filter(field => /permission/i.test(field.key)), []);
  });

  test(`${name}: empty installation receives the first direct message without initializing permissions`, async () => {
    const { [factory]: create } = await import(packedRoots
      ? pathToFileURL(join(packedRoots[name], 'dist/plugin-entrypoint.js')).href
      : `../packages/connector-${name}/src/plugin-entrypoint.ts`);
    const manifest = parse(await readFile(manifestPath, 'utf8'));
    const state = new Map(); const sent = []; let inbound;
    const summary = { id: 'bound', title: 'Conversation', createdAt: 1, lastActiveAt: 1, preferredCats: [], featureRefs: [], deepLinkUrl: 'https://owner.example/thread/bound' };
    const host = {
      config: { get: async key => ({ connectionMode: 'webhook', appKey: 'app', corpId: 'corp', agentId: 'agent', botId: 'bot', accessKey: 'access' })[key] },
      secrets: { get: async () => 'secret' },
      storage: {
        get: async key => state.get(key), list: async () => Object.fromEntries(state),
        set: async (key, value) => { const revision = (state.get(key)?.revision ?? 0) + 1; state.set(key, { revision, value }); return { revision }; },
        compareAndSet: async (key, expected, value) => { const current = state.get(key);
          if ((current?.revision ?? null) !== expected) return { applied: false };
          const revision = (current?.revision ?? 0) + 1; state.set(key, { revision, value }); return { applied: true, revision }; },
        delete: async key => ({ deleted: state.delete(key) }),
      },
      threads: { get: async () => summary, create: async () => summary },
      messaging: { subscribe: async () => {}, unsubscribe: async () => {}, send: async input => {
        sent.push(input); return { messageId: `m-${sent.length}`, threadId: input.threadId, revision: 1, messageHandle: 'handle', pendingPublication: true }; } },
      log() {},
    };
    const module = create(options => { inbound = options.host.deliver; return {
      outbound: { async sendReply() {}, async sendFormattedReply() {}, async onDeliveryBatchDone() {} },
      async start() {}, async stop() {},
    }; });
    const active = await module.create(manifest).start(host);
    try {
      await inbound({ externalConversationId: 'direct', externalSenderId: 'sender', providerMessageId: 'first', text: 'hello',
        chatType: 'p2p', conversation: { type: 'direct' }, sender: { id: 'sender' } });
      assert.equal(sent.length, 1, 'the first ordinary message follows the original ingress path');
      assert.equal(sent[0].threadId, 'bound');
      assert.deepEqual(Object.keys(active.actions).filter(key => key.startsWith('permissions.')), [], 'no active legacy import or separate permission form actions');
      assert.equal(state.has('connector.permissions.v1'), false, 'fresh message does not create a second setup record');
      if (groupConnectors.has(name)) {
        await inbound({ externalConversationId: 'group', externalSenderId: 'sender', providerMessageId: 'group-first', text: 'hello',
          chatType: 'group', conversation: { type: 'group' }, sender: { id: 'sender' } });
        assert.equal(sent.length, 2, 'the original initial policy has no group whitelist restriction');
      } else {
        await inbound({ externalConversationId: 'direct', externalSenderId: 'sender', providerMessageId: 'second', text: 'hello again',
          chatType: 'p2p', conversation: { type: 'direct' }, sender: { id: 'sender' } });
        assert.equal(sent.length, 2);
        assert.equal(state.has('connector.permissions.v1'), false, 'normal direct ingress does not initialize unused group policy');
      }
    } finally { await active.stop({reason:'test'}); }
  });
}

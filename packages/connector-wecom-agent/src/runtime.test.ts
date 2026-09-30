import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWeComAgentConnectorRuntime,
  type WeComAgentRuntimeAdapter,
} from './runtime.js';
import type { ConnectorLogger } from './types.js';

const logger: ConnectorLogger = { info() {}, warn() {}, error() {}, debug() {} };

test('runtime verifies challenges and routes decrypted provider facts', async () => {
  const delivered: unknown[] = [];
  const adapter = {
    connectorId: 'wecom-agent',
    verifyCallback: () => 'plain-echo',
    decryptInbound: () => '<xml/>',
    parseEvent: () => ({
      chatId: 'user-1', senderId: 'user-1', messageId: 'message-1', text: '@cat is ordinary text',
      attachments: [{ type: 'video' as const, mediaId: 'media-1', fileName: 'clip.mp4' }],
    }),
    async sendFormattedReply() {}, async sendMedia() {}, async sendReply() {},
  } as WeComAgentRuntimeAdapter;
  const runtime = createWeComAgentConnectorRuntime({
    config: {
      corpId: ' corp ', agentId: ' agent ', agentSecret: ' secret ', callbackToken: ' token ', encodingAesKey: ' aes ',
    },
    logger,
    host: { deliver: async message => { delivered.push(message); } },
    createAdapter: (_logger, config) => {
      assert.deepEqual(config, {
        corpId: 'corp', agentId: 'agent', agentSecret: 'secret', token: 'token', encodingAesKey: 'aes',
      });
      return adapter;
    },
  });
  await runtime.start();
  assert.deepEqual(await runtime.handleWebhook({ query: { echostr: 'cipher' } }), {
    kind: 'challenge', response: 'plain-echo',
  });
  assert.deepEqual(await runtime.handleWebhook({ body: '<encrypted/>', query: {} }), {
    kind: 'processed', messageId: 'message-1',
  });
  assert.deepEqual(delivered, [{
    externalConversationId: 'user-1', externalSenderId: 'user-1', providerMessageId: 'message-1',
    text: '@cat is ordinary text',
    attachments: [{ type: 'file', platformKey: 'media-1', fileName: 'clip.mp4' }],
  }]);
});

test('runtime rejects malformed query authority and all work after disposal', async () => {
  const adapter = {
    connectorId: 'wecom-agent', verifyCallback: () => null, decryptInbound: () => null, parseEvent: () => null,
    async sendFormattedReply() {}, async sendMedia() {}, async sendReply() {},
  } as WeComAgentRuntimeAdapter;
  const runtime = createWeComAgentConnectorRuntime({
    config: { corpId: 'c', agentId: 'a', agentSecret: 's', callbackToken: 't', encodingAesKey: 'e' },
    logger,
    host: { deliver: async () => undefined },
    createAdapter: () => adapter,
  });
  await assert.rejects(runtime.handleWebhook({ query: { timestamp: 1 } } as never), /query/u);
  await assert.rejects(runtime.handleWebhook({ query: {} }), /body must be XML text/u);
  await runtime.stop();
  await assert.rejects(runtime.handleWebhook({}), /stopped/u);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFeishuConnectorRuntime,
  type FeishuRuntimeAdapter,
} from './runtime.js';
import type { ConnectorLogger } from './types.js';

const logger: ConnectorLogger = { info() {}, warn() {}, error() {}, debug() {} };
const fetchFn: typeof fetch = async (input) => new Response(
  String(input).includes('/bot/v3/info')
    ? JSON.stringify({ bot: { open_id: 'bot-open-id' } })
    : JSON.stringify({ tenant_access_token: 'token', expire: 3600 }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

function adapter(): FeishuRuntimeAdapter {
  return {
    connectorId: 'feishu',
    isVerificationChallenge: body => (body as { challenge?: string })?.challenge
      ? { challenge: (body as { challenge: string }).challenge } : null,
    verifyEventToken: () => true,
    parseEvent: () => ({
      chatId: 'group-1', senderId: 'user-1', messageId: 'message-1', text: '@cat is ordinary text', chatType: 'group',
      attachments: [{ type: 'image', feishuKey: 'image-1' }],
    }),
    parseCardAction: () => null,
    async resolveSenderName() { return 'User'; },
    async resolveSenderNameFromChat() { return undefined; },
    async resolveChatName() { return 'Group'; },
    async resolveChatType() { return 'group'; },
    setBotOpenId() {},
    async sendFormattedReply() {}, async sendMedia() {}, async sendReply() {},
  };
}

test('webhook runtime verifies provider input and delivers resolved provider facts', async () => {
  const delivered: unknown[] = [];
  const subject = adapter();
  const runtime = createFeishuConnectorRuntime({
    config: { appId: ' app ', appSecret: ' secret ', connectionMode: 'webhook', verificationToken: 'verify' },
    host: { deliver: async message => { delivered.push(message); } },
    logger,
    fetchFn,
    createAdapter: (appId, appSecret, _logger, options) => {
      assert.equal(appId, 'app');
      assert.equal(appSecret, 'secret');
      assert.deepEqual(options, { verificationToken: 'verify' });
      return subject;
    },
  });
  await runtime.start();
  assert.deepEqual(await runtime.handleWebhook({ body: { challenge: 'c' } }), {
    kind: 'challenge', response: { challenge: 'c' },
  });
  assert.deepEqual(await runtime.handleWebhook({ body: { event: true } }), {
    kind: 'processed', messageId: 'message-1',
  });
  assert.deepEqual(delivered, [{
    externalConversationId: 'group-1', providerMessageId: 'message-1', text: '@cat is ordinary text',
    attachments: [{ type: 'image', platformKey: 'image-1' }],
    sender: { id: 'user-1', name: 'User' },
    conversation: { type: 'group', title: 'Group' },
  }]);
});

test('stop during WebSocket start waits and then closes the exact client once', async () => {
  let releaseStart: (() => void) | undefined;
  const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
  let closes = 0;
  const runtime = createFeishuConnectorRuntime({
    config: { appId: 'app', appSecret: 'secret', connectionMode: 'websocket' },
    host: { deliver: async () => undefined },
    logger,
    fetchFn,
    createAdapter: () => adapter(),
    createWsClient: () => ({
      async start() { await startGate; },
      close() { closes += 1; },
    }),
  });
  const starting = runtime.start();
  const stopping = runtime.stop();
  await Promise.resolve();
  assert.equal(closes, 0);
  releaseStart?.();
  await Promise.all([starting, stopping]);
  await runtime.stop();
  assert.equal(closes, 1);
});

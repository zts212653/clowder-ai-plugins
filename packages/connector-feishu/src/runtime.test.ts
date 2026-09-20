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

test('webhook events received before start are reported as skipped, not processed', async () => {
  const delivered: unknown[] = [];
  const runtime = createFeishuConnectorRuntime({
    config: { appId: 'app', appSecret: 'secret', connectionMode: 'webhook' },
    host: { deliver: async message => { delivered.push(message); } },
    logger,
    fetchFn,
    createAdapter: () => adapter(),
  });
  // State is 'idle' — start() was never called.
  assert.deepEqual(await runtime.handleWebhook({ body: { event: true } }), {
    kind: 'skipped', reason: 'not_running',
  });
  assert.equal(delivered.length, 0, 'events arriving before start must not be delivered or reported as processed');
  // URL verification challenge stays stateless — still answered before start.
  assert.deepEqual(await runtime.handleWebhook({ body: { challenge: 'c' } }), {
    kind: 'challenge', response: { challenge: 'c' },
  });
});

test('card action with unresolvable chat type is reported as chat_type_unknown while running', async () => {
  const subject = adapter();
  subject.parseCardAction = () => ({
    chatId: 'chat-9',
    senderId: 'user-1',
    actionValue: { cmd: '/status' },
  });
  subject.resolveChatType = async () => undefined;
  const runtime = createFeishuConnectorRuntime({
    config: { appId: 'app', appSecret: 'secret', connectionMode: 'webhook' },
    host: { deliver: async () => undefined },
    logger,
    fetchFn,
    createAdapter: () => subject,
  });
  await runtime.start();
  assert.deepEqual(await runtime.handleWebhook({ body: { card: true } }), {
    kind: 'skipped', reason: 'chat_type_unknown',
  });
});

test('stop during WebSocket start closes the exact client without waiting for start settlement', async () => {
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
  await stopping;
  assert.equal(closes, 1);
  releaseStart?.();
  await starting;
  await runtime.stop();
  assert.equal(closes, 1);
});

test('WebSocket callbacks retained by the provider cannot deliver after stop', async () => {
  let dispatcher: { handles: Map<string, (data: Record<string, unknown>) => Promise<void>> } | undefined;
  const delivered: unknown[] = [];
  const runtime = createFeishuConnectorRuntime({
    config: { appId: 'app', appSecret: 'secret', connectionMode: 'websocket' },
    host: { deliver: async message => { delivered.push(message); } },
    logger,
    fetchFn,
    createAdapter: () => adapter(),
    createWsClient: () => ({
      async start({ eventDispatcher }) {
        dispatcher = eventDispatcher as unknown as typeof dispatcher;
      },
      close() {},
    }),
  });

  await runtime.start();
  await runtime.stop();
  const inbound = dispatcher?.handles.get('im.message.receive_v1');
  assert.ok(inbound);
  await inbound({});
  assert.equal(delivered.length, 0, 'provider callbacks after stop must not reach the Host');
});

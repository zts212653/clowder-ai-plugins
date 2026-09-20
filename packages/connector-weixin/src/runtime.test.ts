import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWeixinConnectorRuntime,
  type WeixinRuntimeAdapter,
} from './runtime.js';
import type { WeixinInboundMessage, WeixinSessionStateStore } from './WeixinAdapter.js';
import type { ConnectorLogger } from './types.js';

const logger: ConnectorLogger = { info() {}, warn() {}, error() {}, debug() {} };
const sessionState: WeixinSessionStateStore = {
  async load() { return null; },
  async save() {},
  async clear() {},
};

function provider() {
  let handler: ((message: WeixinInboundMessage) => Promise<void>) | undefined;
  let releaseRestore: (() => void) | undefined;
  let stops = 0;
  const restoreGate = new Promise<void>(resolve => { releaseRestore = resolve; });
  const adapter = {
    connectorId: 'weixin',
    async restoreSessionState() { await restoreGate; },
    startPolling(next: (message: WeixinInboundMessage) => Promise<void>) { handler = next; },
    async stopPolling() { stops += 1; },
    async sendReply() {},
    async sendMedia() {},
  } as WeixinRuntimeAdapter;
  return {
    adapter,
    releaseRestore: () => releaseRestore?.(),
    stopCalls: () => stops,
    inbound: async (message: WeixinInboundMessage) => {
      assert.ok(handler);
      await handler(message);
    },
  };
}

test('runtime restores Host-owned state before ingress and forwards provider facts only', async () => {
  const fake = provider();
  const delivered: unknown[] = [];
  const runtime = createWeixinConnectorRuntime({
    config: { botToken: ' token ', voiceItemMode: 'minimal' },
    state: sessionState,
    logger,
    host: { deliver: async message => { delivered.push(message); } },
    createAdapter: (token, _logger, state, options) => {
      assert.equal(token, 'token');
      assert.equal(state, sessionState);
      assert.deepEqual(options, { voiceItemMode: 'minimal' });
      return fake.adapter;
    },
  });
  const starting = runtime.start();
  fake.releaseRestore();
  await starting;
  await fake.inbound({
    chatId: 'chat-1', senderId: 'user-1', messageId: 'message-1', text: 'hello', contextToken: 'opaque',
    attachments: [{ type: 'image', mediaUrl: '{"fullUrl":"https://media"}' }],
  });
  assert.deepEqual(delivered, [{
    externalConversationId: 'chat-1',
    externalSenderId: 'user-1',
    providerMessageId: 'message-1',
    text: 'hello',
    attachments: [{ type: 'image', platformKey: '{"fullUrl":"https://media"}' }],
  }]);
});

test('stop during state restoration cannot claim drain before polling is stopped', async () => {
  const fake = provider();
  const runtime = createWeixinConnectorRuntime({
    config: { botToken: 'token' },
    state: sessionState,
    logger,
    host: { deliver: async () => undefined },
    createAdapter: () => fake.adapter,
  });
  const starting = runtime.start();
  const stopping = runtime.stop();
  await Promise.resolve();
  assert.equal(fake.stopCalls(), 0);
  fake.releaseRestore();
  await Promise.all([starting, stopping]);
  assert.equal(fake.stopCalls(), 1);
});

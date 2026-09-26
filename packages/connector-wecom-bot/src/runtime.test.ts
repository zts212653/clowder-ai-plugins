import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWeComBotConnectorRuntime,
  type WeComBotRuntimeAdapter,
} from './runtime.js';
import type { WeComBotInboundMessage } from './WeComBotAdapter.js';
import type { ConnectorLogger } from './types.js';

const logger: ConnectorLogger = { info() {}, warn() {}, error() {}, debug() {} };

function provider() {
  let handler: ((message: WeComBotInboundMessage) => Promise<void>) | undefined;
  let releaseStart: (() => void) | undefined;
  let stops = 0;
  const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
  const adapter = {
    connectorId: 'wecom-bot',
    async startStream(next: (message: WeComBotInboundMessage) => Promise<void>) {
      handler = next;
      await startGate;
    },
    async stopStream() { stops += 1; },
    async sendFormattedReply() {},
    async sendMedia() {},
    async sendReply() {},
  } as unknown as WeComBotRuntimeAdapter;
  return {
    adapter,
    releaseStart: () => releaseStart?.(),
    stopCalls: () => stops,
    inbound: async (message: WeComBotInboundMessage) => {
      assert.ok(handler);
      await handler(message);
    },
  };
}

test('runtime maps provider facts and preserves the opaque encrypted media key', async () => {
  const fake = provider();
  const delivered: unknown[] = [];
  const runtime = createWeComBotConnectorRuntime({
    config: { botId: ' bot ', botSecret: ' secret ' },
    logger,
    host: { deliver: async message => { delivered.push(message); } },
    createAdapter: (_logger, config) => {
      assert.deepEqual(config, { botId: 'bot', secret: 'secret' });
      return fake.adapter;
    },
  });
  const starting = runtime.start();
  fake.releaseStart();
  await starting;
  await fake.inbound({
    chatId: 'group-1',
    messageId: 'message-1',
    senderId: 'user-1',
    text: '@cat remains provider text',
    chatType: 'group',
    attachments: [{ type: 'voice', url: 'https://media.example/voice', aesKey: 'key' }],
  });
  assert.deepEqual(delivered, [{
    externalConversationId: 'group-1',
    providerMessageId: 'message-1',
    text: '@cat remains provider text',
    attachments: [{ type: 'audio', platformKey: 'https://media.example/voice|aeskey=key' }],
    sender: { id: 'user-1' },
    conversation: { type: 'group' },
  }]);
  assert.equal(Object.hasOwn(delivered[0] as object, 'threadId'), false);
  await runtime.stop();
  await fake.inbound({
    chatId: 'group-1', messageId: 'message-after-stop', senderId: 'user-1', text: 'must not deliver', chatType: 'group',
  });
  assert.equal(delivered.length, 1, 'provider callbacks after stop must not reach the Host');
});

test('stop during start waits for provider setup and drains exactly once', async () => {
  const fake = provider();
  const runtime = createWeComBotConnectorRuntime({
    config: { botId: 'bot', botSecret: 'secret' },
    logger,
    host: { deliver: async () => undefined },
    createAdapter: () => fake.adapter,
  });
  const starting = runtime.start();
  const stopping = runtime.stop();
  await Promise.resolve();
  assert.equal(fake.stopCalls(), 0);
  fake.releaseStart();
  await Promise.all([starting, stopping]);
  await runtime.stop();
  assert.equal(fake.stopCalls(), 1);
  await assert.rejects(runtime.start(), /stopped/u);
});

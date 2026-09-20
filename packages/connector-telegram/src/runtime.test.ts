import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createTelegramConnectorRuntime,
  type TelegramRuntimeAdapter,
} from './runtime.js';
import type { TelegramInboundMessage } from './TelegramAdapter.js';
import type { ConnectorLogger } from './types.js';

function silentLogger(): ConnectorLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function fakeAdapter() {
  let handler: ((message: TelegramInboundMessage) => Promise<void>) | undefined;
  let stopCalls = 0;
  const adapter: TelegramRuntimeAdapter = {
    startPolling(next) {
      handler = next;
    },
    async stopPolling() {
      stopCalls += 1;
    },
  };
  return {
    adapter,
    inbound: async (message: TelegramInboundMessage) => {
      assert.ok(handler, 'runtime must register the provider ingress handler before delivery');
      await handler(message);
    },
    stopCalls: () => stopCalls,
  };
}

test('runtime rejects an invalid explicit bot token before constructing provider state', () => {
  let constructed = false;
  assert.throws(
    () => createTelegramConnectorRuntime({
      config: { botToken: 'not-a-token' },
      host: { deliver: async () => undefined },
      logger: silentLogger(),
      createAdapter: () => {
        constructed = true;
        return fakeAdapter().adapter;
      },
    }),
    /botToken/u,
  );
  assert.equal(constructed, false);
});

test('runtime maps provider ingress to Host-owned delivery without inventing a target', async () => {
  const provider = fakeAdapter();
  const delivered: unknown[] = [];
  const runtime = createTelegramConnectorRuntime({
    config: { botToken: ' 123456:abcdefghij_ABC-123 ' },
    host: { deliver: async message => delivered.push(message) },
    logger: silentLogger(),
    createAdapter: token => {
      assert.equal(token, '123456:abcdefghij_ABC-123');
      return provider.adapter;
    },
  });

  runtime.start();
  await provider.inbound({
    chatId: 'chat-1',
    senderId: 'user-1',
    messageId: 'message-1',
    text: '@cat remains ordinary provider text',
    attachments: [{
      type: 'file',
      telegramFileId: 'file-1',
      fileName: 'proof.txt',
    }],
  });

  assert.deepEqual(delivered, [{
    externalConversationId: 'chat-1',
    externalSenderId: 'user-1',
    providerMessageId: 'message-1',
    text: '@cat remains ordinary provider text',
    attachments: [{
      type: 'file',
      platformKey: 'file-1',
      fileName: 'proof.txt',
    }],
  }]);
  assert.equal(Object.hasOwn(delivered[0] as object, 'address'), false);
  assert.equal(Object.hasOwn(delivered[0] as object, 'threadId'), false);
});

test('runtime owns polling lifecycle and drains exactly once', async () => {
  const provider = fakeAdapter();
  const runtime = createTelegramConnectorRuntime({
    config: { botToken: '123456:abcdefghij_ABC-123' },
    host: { deliver: async () => undefined },
    logger: silentLogger(),
    createAdapter: () => provider.adapter,
  });

  runtime.start();
  assert.throws(() => runtime.start(), /already started/u);
  await runtime.stop();
  await runtime.stop();
  assert.equal(provider.stopCalls(), 1);
  assert.throws(() => runtime.start(), /stopped/u);
});

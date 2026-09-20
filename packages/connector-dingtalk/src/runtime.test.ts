import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDingTalkConnectorRuntime,
  type DingTalkRuntimeAdapter,
} from './runtime.js';
import type { DingTalkInboundMessage } from './DingTalkAdapter.js';
import type { ConnectorLogger } from './types.js';

function silentLogger(): ConnectorLogger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function fakeAdapter() {
  let handler: ((message: DingTalkInboundMessage) => Promise<void>) | undefined;
  let stopCalls = 0;
  const adapter: DingTalkRuntimeAdapter = {
    async startStream(next) {
      handler = next;
    },
    async stopStream() {
      stopCalls += 1;
    },
    resolveSenderName(senderId) {
      return senderId === 'user-1' ? 'Resolved user' : undefined;
    },
    resolveConversationTitle(chatId) {
      return chatId === 'group-1' ? 'Resolved group' : undefined;
    },
  };
  return {
    adapter,
    inbound: async (message: DingTalkInboundMessage) => {
      assert.ok(handler, 'runtime must register the provider ingress handler before delivery');
      await handler(message);
    },
    stopCalls: () => stopCalls,
  };
}

test('runtime requires explicit declared credentials before provider construction', () => {
  let constructed = false;
  assert.throws(() => createDingTalkConnectorRuntime({
    config: { appKey: 'app-key', appSecret: ' ' },
    host: { deliver: async () => undefined },
    logger: silentLogger(),
    createAdapter: () => {
      constructed = true;
      return fakeAdapter().adapter;
    },
  }), /appSecret/u);
  assert.equal(constructed, false);
});

test('runtime emits provider facts and leaves binding resolution to the Host', async () => {
  const provider = fakeAdapter();
  const delivered: unknown[] = [];
  const runtime = createDingTalkConnectorRuntime({
    config: { appKey: ' app-key ', appSecret: ' app-secret ' },
    host: { deliver: async message => delivered.push(message) },
    logger: silentLogger(),
    createAdapter: config => {
      assert.deepEqual(config, { appKey: 'app-key', appSecret: 'app-secret' });
      return provider.adapter;
    },
  });

  await runtime.start();
  await provider.inbound({
    chatId: 'group-1',
    conversationId: 'conversation-1',
    text: '@cat is provider content, not wake authority',
    messageId: 'message-1',
    senderId: 'user-1',
    chatType: 'group',
    attachments: [{ type: 'image', downloadCode: 'download-1' }],
  });

  assert.deepEqual(delivered, [{
    externalConversationId: 'group-1',
    providerConversationId: 'conversation-1',
    providerMessageId: 'message-1',
    text: '@cat is provider content, not wake authority',
    sender: { id: 'user-1', name: 'Resolved user' },
    chatType: 'group',
    chatName: 'Resolved group',
    attachments: [{ type: 'image', platformKey: 'download-1' }],
  }]);
  assert.equal(Object.hasOwn(delivered[0] as object, 'address'), false);
  assert.equal(Object.hasOwn(delivered[0] as object, 'threadId'), false);
});

test('runtime drains the provider stream exactly once', async () => {
  const provider = fakeAdapter();
  const runtime = createDingTalkConnectorRuntime({
    config: { appKey: 'app-key', appSecret: 'app-secret' },
    host: { deliver: async () => undefined },
    logger: silentLogger(),
    createAdapter: () => provider.adapter,
  });

  await runtime.start();
  await runtime.stop();
  await runtime.stop();
  assert.equal(provider.stopCalls(), 1);
  await assert.rejects(runtime.start(), /stopped/u);
});

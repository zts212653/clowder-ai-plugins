import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createXiaoyiConnectorRuntime,
  type XiaoyiRuntimeAdapter,
} from './runtime.js';
import type { XiaoyiInboundMessage } from './xiaoyi-protocol.js';
import type { ConnectorLogger } from './types.js';

const logger: ConnectorLogger = { info() {}, warn() {}, error() {}, debug() {} };

function provider() {
  let handler: ((message: XiaoyiInboundMessage) => Promise<void>) | undefined;
  let releaseStart: (() => void) | undefined;
  let stops = 0;
  const startGate = new Promise<void>(resolve => { releaseStart = resolve; });
  const adapter = {
    connectorId: 'xiaoyi',
    async startStream(next: (message: XiaoyiInboundMessage) => Promise<void>) {
      handler = next;
      await startGate;
    },
    async stopStream() { stops += 1; },
    async sendReply() {},
    async onDeliveryBatchDone() {},
  } as XiaoyiRuntimeAdapter;
  return {
    adapter,
    releaseStart: () => releaseStart?.(),
    stopCalls: () => stops,
    inbound: async (message: XiaoyiInboundMessage) => {
      assert.ok(handler);
      await handler(message);
    },
  };
}

test('runtime maps explicit config and delivers no Host authority fields', async () => {
  const fake = provider();
  const delivered: unknown[] = [];
  const runtime = createXiaoyiConnectorRuntime({
    config: { accessKey: ' ak ', secretKey: ' sk ', agentId: ' agent ' },
    logger,
    host: { deliver: async message => { delivered.push(message); } },
    createAdapter: (_logger, config) => {
      assert.deepEqual(config, { ak: 'ak', sk: 'sk', agentId: 'agent' });
      return fake.adapter;
    },
  });
  const starting = runtime.start();
  fake.releaseStart();
  await starting;
  await fake.inbound({ chatId: 'agent:session', senderId: 'owner:agent', messageId: 'task-1', taskId: 'task-1', text: 'hello' });
  assert.deepEqual(delivered, [{
    externalConversationId: 'agent:session',
    externalSenderId: 'owner:agent',
    providerMessageId: 'task-1',
    text: 'hello',
  }]);
  assert.equal(Object.hasOwn(delivered[0] as object, 'address'), false);
  await runtime.stop();
  await fake.inbound({
    chatId: 'agent:session', senderId: 'owner:agent', messageId: 'message-after-stop', taskId: 'task-2', text: 'must not deliver',
  });
  assert.equal(delivered.length, 1, 'provider callbacks after stop must not reach the Host');
});

test('stop during start drains the dual WebSocket runtime once', async () => {
  const fake = provider();
  const runtime = createXiaoyiConnectorRuntime({
    config: { accessKey: 'ak', secretKey: 'sk', agentId: 'agent' },
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
});

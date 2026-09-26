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
    connectorId: 'dingtalk',
    async sendReply() {
      return undefined;
    },
    async startStream(next) {
      handler = next;
    },
    async stopStream() {
      stopCalls += 1;
    },
    isStreamLive() {
      return true;
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
    host: { deliver: async message => { delivered.push(message); } },
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
  await runtime.stop();
  await provider.inbound({
    chatId: 'group-1',
    conversationId: 'conversation-1',
    text: 'must not deliver',
    messageId: 'message-after-stop',
    senderId: 'user-1',
    chatType: 'group',
  });
  assert.equal(delivered.length, 1, 'provider callbacks after stop must not reach the Host');
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

test('stop during an in-flight provider start cancels without waiting for start settlement', async () => {
  let releaseStart!: () => void;
  const startGate = new Promise<void>(resolve => {
    releaseStart = resolve;
  });
  let stopCalls = 0;
  const adapter: DingTalkRuntimeAdapter = {
    connectorId: 'dingtalk',
    async sendReply() {
      return undefined;
    },
    startStream: async () => startGate,
    async stopStream() {
      stopCalls += 1;
    },
    isStreamLive() {
      return true;
    },
    resolveSenderName: () => undefined,
    resolveConversationTitle: () => undefined,
  };
  const runtime = createDingTalkConnectorRuntime({
    config: { appKey: 'app-key', appSecret: 'app-secret' },
    host: { deliver: async () => undefined },
    logger: silentLogger(),
    createAdapter: () => adapter,
  });

  const starting = runtime.start();
  assert.equal(runtime.start(), starting, 'repeated start must join the same lifecycle transition');
  const stopping = runtime.stop();
  await Promise.resolve();
  await stopping;
  assert.equal(stopCalls, 1, 'drain must cancel the in-flight provider start immediately');
  releaseStart();
  await starting;
  assert.equal(stopCalls, 1);
});

// G1/N1: the SDK retries a dead stream silently, so the runtime watchdog must
// notice isStreamLive() === false, drain, and reconnect until stop() converges.
test('watchdog reconnects a dead provider stream and stop converges the cycle', async () => {
  let handler: ((message: DingTalkInboundMessage) => Promise<void>) | undefined;
  let live = true;
  let startCalls = 0;
  let stopCalls = 0;
  const errors: string[] = [];
  const adapter: DingTalkRuntimeAdapter = {
    connectorId: 'dingtalk',
    async sendReply() { return undefined; },
    async startStream(next) {
      startCalls += 1;
      handler = next;
    },
    async stopStream() {
      stopCalls += 1;
    },
    isStreamLive() {
      return live;
    },
    resolveSenderName: () => undefined,
    resolveConversationTitle: () => undefined,
  };
  const delivered: unknown[] = [];
  const runtime = createDingTalkConnectorRuntime({
    config: { appKey: 'app-key', appSecret: 'app-secret' },
    host: { deliver: async message => { delivered.push(message); } },
    logger: {
      info() {},
      warn() {},
      error(msg: unknown) { errors.push(String(msg)); },
    },
    streamWatchdogIntervalMs: 20,
    reconnectDelayMs: 20,
    createAdapter: () => adapter,
  });
  await runtime.start();
  assert.equal(startCalls, 1);
  live = false; // e.g. credentials revoked: SDK retries silently, stream dead
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(startCalls >= 2, 'the watchdog must restart a dead stream');
  assert.ok(stopCalls >= 1, 'the dead stream must be drained before reconnect');
  assert.ok(errors.some(entry => entry.includes('not live')), 'the dead stream must be logged as an error');
  live = true;
  // The dead-stream cycle spins every watchdog+backoff tick; give the in-flight
  // cycle a beat to settle into a live 'running' stream before driving ingress
  // through it, or the handler can land in an 'idle' reconnect window.
  await new Promise(resolve => setTimeout(resolve, 100));
  await handler?.({
    chatId: 'group-1',
    conversationId: 'conversation-1',
    text: 'after reconnect',
    messageId: 'message-reconnected',
    senderId: 'user-1',
    chatType: 'group',
  });
  assert.equal(delivered.length, 1, 'ingress must flow again once the reconnect settles running');
  const callsAtStop = startCalls;
  await runtime.stop();
  live = false;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(startCalls, callsAtStop, 'stop() must clear the watchdog and prevent further reconnects');
});

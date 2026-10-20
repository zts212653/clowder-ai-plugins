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
  } as unknown as WeixinRuntimeAdapter;
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
  await runtime.stop();
  await fake.inbound({
    chatId: 'chat-1', senderId: 'user-1', messageId: 'message-after-stop', text: 'must not deliver', contextToken: 'opaque',
  });
  assert.equal(delivered.length, 1, 'provider callbacks after stop must not reach the Host');
});

test('disconnect during session restore supersedes the stale chain; a later connect still polls', async () => {
  const events: string[] = [];
  let releaseRestore: (() => void) | undefined;
  const restoreGate = new Promise<void>(resolve => { releaseRestore = resolve; });
  const makeAdapter = (label: string) => {
    let polling = false;
    return {
      connectorId: 'weixin',
      async restoreSessionState() { events.push(`${label}:restore`); await restoreGate; },
      startPolling() { polling = true; events.push(`${label}:poll`); },
      async stopPolling() { polling = false; },
      async sendReply() {}, async sendMedia() {},
      hasBotToken() { return true; },
      isPolling() { return polling; },
      setBotToken() {},
      async disconnect() { events.push(`${label}:disconnect`); polling = false; },
    } as unknown as WeixinRuntimeAdapter;
  };
  const runtime = createWeixinConnectorRuntime({
    config: { botToken: '' },
    state: sessionState,
    logger,
    host: { deliver: async () => undefined },
    createAdapter: (token) => makeAdapter(token),
  });
  await runtime.start();
  // Connect t1 while its session restore is still in flight, then drop the
  // connection before the chain resumes.
  const connecting = runtime.connect('token-1');
  await runtime.disconnect();
  releaseRestore?.();
  await connecting;
  // A later connect must begin polling with the new token: the superseded
  // chain must neither poll the stale adapter nor publish state='running'
  // (which would make this connect skip beginPolling entirely).
  await runtime.connect('token-2');
  // disconnect() runs before the superseded chain's first microtask, so its
  // event lands first; the essential facts are: the stale chain never polls
  // token-1, and the replacement connection restores + polls token-2.
  assert.deepEqual(events, ['token-1:disconnect', 'token-1:restore', 'token-2:restore', 'token-2:poll']);
  assert.equal(events.includes('token-1:poll'), false, 'the superseded chain must not start polling the dropped adapter');
  assert.equal(runtime.isConnected(), true, 'the replacement connection must be live');
  await runtime.stop();
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

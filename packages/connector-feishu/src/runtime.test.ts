import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFeishuConnectorRuntime,
  PausableLarkWsClient,
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

// F2/F3: PausableLarkWsClient teardown semantics against an SDK-shaped fake
// (lark WSClient.start() resolves in the same tick; the socket is registered
// via wsConfig.setWSInstance only once 'open' fires).
interface FakeSdkSocket {
  events: string[];
}

function fakeLarkInner() {
  let instance: unknown = null;
  const inner = {
    startCalls: 0,
    closedWith: undefined as { force?: boolean } | undefined,
    isConnecting: undefined as boolean | undefined,
    async start(_options: unknown) { this.startCalls += 1; },
    close(options?: { force?: boolean }) { this.closedWith = options; },
    pingLoop() { /* SDK would reschedule the ping timer here */ },
    wsConfig: {
      getWSInstance() { return instance; },
      setWSInstance(ws: unknown) { instance = ws; },
    },
  };
  return inner;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Mirrors the real SDK-registered ws.WebSocket shape: readyState plus an
// event-emitter surface (terminate/removeAllListeners are added where a test
// needs them). H1: start() accepts a registered socket only when
// readyState === OPEN, so fakes must carry it like the real socket does.
function fakeOpenSocket() {
  const listeners = new Map<string, () => void>();
  return {
    readyState: 1,
    on(event: string, listener: () => void) { listeners.set(event, listener); },
    emitClose() { listeners.get('close')?.(); },
    removeAllListeners() { listeners.clear(); },
    terminate() { /* terminate is a no-op on the fake */ },
  };
}

test('PausableLarkWsClient start settles only after the SDK registers an open socket', async () => {
  const inner = fakeLarkInner();
  const client = new PausableLarkWsClient('app-id', 'app-secret', inner);
  let settled = false;
  const started = client.start({ eventDispatcher: {} as never }).then(() => { settled = true; });
  await tick();
  assert.equal(settled, false, 'start must not settle before the socket is open');
  inner.wsConfig.setWSInstance(fakeOpenSocket());
  await started;
  assert.equal(settled, true);
});

// H1: with autoReconnect off the lark SDK leaves a CLOSED socket registered
// (its close handler returns before setWSInstance(null)); a bare `!== null`
// poll accepts the corpse and reports 'running' over a dead socket. start()
// must refuse it instead, so the failure routes into supervised reconnect.
test('PausableLarkWsClient start refuses a registered socket that is not OPEN', async () => {
  for (const readyState of [2, 3]) { // CLOSING, CLOSED
    const inner = fakeLarkInner();
    const client = new PausableLarkWsClient('app-id', 'app-secret', inner);
    const poll = client.start({ eventDispatcher: {} as never });
    await tick();
    inner.wsConfig.setWSInstance({ readyState });
    await assert.rejects(poll, /registered a socket that is not OPEN/);
  }
});

// H1: an unexpected close drives a reconnect; if the fresh attempt lands on an
// already-dead socket (start rejects), the supervision must keep retrying —
// the previous behavior accepted the corpse and went permanently silent.
test('runtime keeps retrying when the reconnect attempt lands on a dead socket', async () => {
  const created: Array<{ onClose?: () => void }> = [];
  let failures = 0;
  const runtime = createFeishuConnectorRuntime({
    config: { appId: 'app', appSecret: 'secret', connectionMode: 'websocket' },
    host: { deliver: async () => undefined },
    logger,
    fetchFn,
    reconnectDelayMs: 20,
    createAdapter: () => adapter(),
    createWsClient: config => {
      created.push(config);
      const index = created.length;
      return {
        async start() {
          if (index >= 2) {
            failures += 1;
            throw new Error('Feishu WSClient registered a socket that is not OPEN (readyState=3)');
          }
        },
        close() { /* drained */ },
      };
    },
  });
  await runtime.start();
  assert.equal(created.length, 1);
  created[0]?.onClose?.(); // first socket dies
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(failures >= 2, `reconnect must keep retrying dead-socket starts, saw ${failures}`);
  assert.ok(created.length >= 3, 'each retry must build a fresh ws client');
  await runtime.stop();
});

test('PausableLarkWsClient stop before open kills the socket born afterwards', async () => {
  const inner = fakeLarkInner();
  const client = new PausableLarkWsClient('app-id', 'app-secret', inner);
  const started = client.start({ eventDispatcher: {} as never });
  client.close();
  const lateSocket: FakeSdkSocket = { events: [] };
  (lateSocket as unknown as { removeAllListeners(): void }).removeAllListeners = () => { lateSocket.events.push('removeAllListeners'); };
  (lateSocket as unknown as { terminate(): void }).terminate = () => { lateSocket.events.push('terminate'); };
  // Late 'open': the SDK tries to register the post-stop socket.
  inner.wsConfig.setWSInstance(lateSocket);
  assert.deepEqual(lateSocket.events, ['removeAllListeners', 'terminate']);
  assert.equal(inner.wsConfig.getWSInstance(), null, 'post-stop socket must never be registered');
  await assert.rejects(started, /stopped during connect/);
  assert.deepEqual(inner.closedWith, { force: true });
  // pingLoop is inert after stop (a late open must not restart the timer).
  inner.pingLoop();
});

test('PausableLarkWsClient close is idempotent', async () => {
  const inner = fakeLarkInner();
  const client = new PausableLarkWsClient('app-id', 'app-secret', inner);
  client.close();
  client.close();
  assert.deepEqual(inner.closedWith, { force: true });
});

// G1: an unexpected socket close must drive the runtime out of 'running' and
// into a supervised reconnect, and stop() must converge the cycle.
test('WebSocket runtime reconnects after an unexpected close and stop converges', async () => {
  const created: Array<{ onClose?: () => void }> = [];
  let closes = 0;
  const starts: string[] = [];
  const errors: string[] = [];
  const runtime = createFeishuConnectorRuntime({
    config: { appId: 'app', appSecret: 'secret', connectionMode: 'websocket' },
    host: { deliver: async () => undefined },
    logger: {
      info(msg: string) { starts.push(String(msg)); },
      warn() {}, debug() {},
      error(msg: unknown) { errors.push(String(msg)); },
    },
    fetchFn,
    reconnectDelayMs: 20,
    createAdapter: () => adapter(),
    createWsClient: config => {
      created.push(config);
      return {
        async start() {},
        close() { closes += 1; },
      };
    },
  });
  await runtime.start();
  assert.equal(created.length, 1);
  created[0]?.onClose?.(); // the open socket dies underneath us
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(created.length, 2, 'the runtime must create a fresh ws client after an unexpected close');
  assert.ok(errors.some(entry => entry.includes('closed unexpectedly')), 'the drop must be logged as an error');
  assert.equal(starts.filter(entry => entry.includes('Provider ingress started')).length, 2);
  await runtime.stop();
  assert.equal(closes, 2);
  const callsAfterStop = created.length;
  created[1]?.onClose?.(); // late close from the drained client must be ignored
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(created.length, callsAfterStop, 'stop() must prevent any further reconnect scheduling');
});

// G3/TOCTOU: stop() landing inside the name-resolution window must make the
// webhook result honestly report 'skipped', not 'processed', and never deliver.
test('webhook reports skipped not_processed when stop kills the route mid-flight', async () => {
  const delivered: unknown[] = [];
  const subject = adapter();
  let releaseResolution!: (value: string) => void;
  subject.resolveSenderName = () => new Promise<string>(resolve => { releaseResolution = resolve; });
  const runtime = createFeishuConnectorRuntime({
    config: { appId: 'app', appSecret: 'secret', connectionMode: 'webhook' },
    host: { deliver: async message => { delivered.push(message); } },
    logger,
    fetchFn,
    createAdapter: () => subject,
  });
  await runtime.start();
  const result = runtime.handleWebhook({ body: { event: true } });
  await Promise.resolve();
  await runtime.stop(); // lands inside the resolveSenderName window
  releaseResolution('User');
  assert.deepEqual(await result, { kind: 'skipped', reason: 'not_running' });
  assert.equal(delivered.length, 0, 'a guard-killed route must never reach the Host');
});

// G3: a card route killed by the state guard must report 'not_running', not
// the route-completed 'chat_type_unknown' reason.
test('webhook card killed by the guard is not misreported as chat_type_unknown', async () => {
  const delivered: unknown[] = [];
  const subject = adapter();
  subject.parseCardAction = () => ({
    chatId: 'chat-9',
    senderId: 'user-1',
    actionValue: { cmd: '/status' },
  });
  let releaseResolution!: (value: 'group') => void;
  subject.resolveChatType = () => new Promise<'group'>(resolve => { releaseResolution = resolve; });
  const runtime = createFeishuConnectorRuntime({
    config: { appId: 'app', appSecret: 'secret', connectionMode: 'webhook' },
    host: { deliver: async message => { delivered.push(message); } },
    logger,
    fetchFn,
    createAdapter: () => subject,
  });
  await runtime.start();
  const result = runtime.handleWebhook({ body: { card: true } });
  await Promise.resolve();
  await runtime.stop();
  releaseResolution('group');
  assert.deepEqual(await result, { kind: 'skipped', reason: 'not_running' });
  assert.equal(delivered.length, 0);
});

// N4: the SDK gives up on a failed handshake in about a second (isConnecting
// cleared, no socket registered); start must fail fast instead of spinning
// the full 30s deadline.
test('PausableLarkWsClient start fails fast when the SDK has already given up', async () => {
  const inner = fakeLarkInner();
  inner.isConnecting = false; // SDK aborted before any socket opened
  const client = new PausableLarkWsClient('app-id', 'app-secret', inner);
  const startedAt = Date.now();
  await assert.rejects(
    client.start({ eventDispatcher: {} as never }),
    /aborted the connection attempt/,
  );
  assert.ok(Date.now() - startedAt < 5_000, 'start must not spin the 30s timeout after the SDK gave up');
});

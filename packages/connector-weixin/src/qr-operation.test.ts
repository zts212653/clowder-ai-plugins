import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import { createWeixinPluginModule } from './plugin-entrypoint.js';
import { createWeixinConnectorRuntime, type WeixinConnectorRuntime, type WeixinRuntimeAdapter } from './runtime.js';
import { WeixinAdapter } from './WeixinAdapter.js';
import type { WeixinInboundMessage, WeixinSessionStateStore } from './WeixinAdapter.js';
import type { ConnectorLogger } from './types.js';

const logger: ConnectorLogger = { info() {}, warn() {}, error() {}, debug() {} };
const sessionState: WeixinSessionStateStore = {
  async load() { return null; },
  async save() {},
  async clear() {},
};
const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8')) as unknown;

/** Mirrors the Host key allowlist in plugin-operation-routes.ts (operationResult). */
const ALLOWED_RESULT_KEYS = new Set(['render', 'data', 'label', 'targetValues', 'advance', 'activate']);
function assertOperationResultShape(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  assert.ok(
    Object.keys(value).every((key) => ALLOWED_RESULT_KEYS.has(key)),
    `operation result contains a key outside the Host allowlist: ${Object.keys(value).join(',')}`,
  );
  assert.equal(typeof (value as { render?: unknown }).render, 'string');
  assert.ok(Object.hasOwn(value, 'data'));
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    for (const [prefix, payload] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return jsonResponse(payload);
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

function runtimeFake() {
  const calls: Record<string, unknown[]> = {};
  let connected = false;
  let polling = false;
  const runtime = {
    get outbound() {
      return {
        hasBotToken: () => connected,
        isPolling: () => polling,
      };
    },
    async start() { polling = true; },
    async stop() { polling = false; },
    async connect(botToken: string) { calls.connect = [botToken]; connected = true; polling = true; },
    async disconnect() { calls.disconnect = []; connected = false; polling = false; },
    isConnected() { return connected && polling; },
  } as unknown as WeixinConnectorRuntime<WeixinAdapter>;
  return { runtime, calls };
}

function hostShape(values: Record<string, unknown>, secrets: Record<string, string | undefined>): ModulePluginHostShape {
  return {
    config: { get: async (key: string) => values[key] },
    secrets: { get: async (key: string) => secrets[key] },
    storage: {
      get: async () => undefined, list: async () => ({}),
      set: async () => ({ revision: 1 }),
      compareAndSet: async () => ({ applied: false }), delete: async () => ({ deleted: false }),
    } as never,
    tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: {
      listBindings: async () => [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }],
      ensureByKey: async (key: string) => ({ id: 'thread-1', title: key, createdAt: 1, lastActiveAt: 1 }),
    } as never,
    messaging: {
      subscribe: async () => undefined, unsubscribe: async () => undefined,
      send: async (input: { threadId: string }) => ({ messageId: 'm-1', threadId: input.threadId }),
    },
    log() {},
  };
}

async function activate(routes: Record<string, unknown>, secrets: Record<string, string | undefined> = {}) {
  WeixinAdapter._injectStaticFetch(fakeFetch(routes));
  const fake = runtimeFake();
  const entrypoint = createWeixinPluginModule(() => fake.runtime);
  const active = await entrypoint.create(manifest).start(hostShape({}, secrets));
  return { active, fake };
}

const QR_ROUTE = 'https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode';
const STATUS_ROUTE = 'https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status';

test('qr-generate returns a decodable PNG data URL and keeps the payload in runtime memory', async () => {
  const { active } = await activate({
    [QR_ROUTE]: { errcode: 0, qrcode_img_content: 'https://liteapp.weixin.qq.com/q/page', qrcode: 'payload-1' },
  });
  const result = await active.actions['weixin.qr-generate']?.({});
  assertOperationResultShape(result);
  assert.equal((result as { render: string }).render, 'img');
  const url = (result as { data: { url: string } }).data.url;
  assert.match(url, /^data:image\/png;base64,/);
  const bytes = Buffer.from(url.split(',')[1], 'base64');
  assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'img data must be a PNG');
  await active.stop();
});

test('qr-status without an in-flight payload is a terminal polling error', async () => {
  const { active } = await activate({});
  const result = await active.actions['weixin.qr-status']?.({});
  assertOperationResultShape(result);
  assert.deepEqual(result, { render: 'polling', data: { status: 'error', message: 'No QR payload — generate first' }, advance: false });
  await active.stop();
});

test('qr-status waiting and scanned continue polling without advancing', async () => {
  for (const status of [0, 1]) {
    const { active } = await activate({
      [QR_ROUTE]: { errcode: 0, qrcode_img_content: 'https://liteapp.weixin.qq.com/q/page', qrcode: 'payload-1' },
      [STATUS_ROUTE]: { errcode: 0, status },
    });
    await active.actions['weixin.qr-generate']?.({});
    const result = await active.actions['weixin.qr-status']?.({});
    assertOperationResultShape(result);
    assert.deepEqual(result, {
      render: 'polling',
      data: { status: status === 0 ? 'waiting' : 'scanned' },
      advance: false,
    });
    await active.stop();
  }
});

test('qr-status expired and error are terminal with the provider message preserved', async () => {
  const cases: Array<[unknown, Record<string, unknown>]> = [
    [3, { render: 'polling', data: { status: 'expired' }, advance: false }],
    ['boom', { render: 'polling', data: { status: 'error', message: 'unknown status boom' }, advance: false }],
  ];
  for (const [providerStatus, expected] of cases) {
    const { active } = await activate({
      [QR_ROUTE]: { errcode: 0, qrcode_img_content: 'https://liteapp.weixin.qq.com/q/page', qrcode: 'payload-1' },
      [STATUS_ROUTE]: { errcode: 0, status: providerStatus },
    });
    await active.actions['weixin.qr-generate']?.({});
    const result = await active.actions['weixin.qr-status']?.({});
    assertOperationResultShape(result);
    assert.deepEqual(result, expected);
    await active.stop();
  }
});

test('qr-status confirmed connects in-process and returns the token as the operation target value', async () => {
  const { active, fake } = await activate({
    [QR_ROUTE]: { errcode: 0, qrcode_img_content: 'https://liteapp.weixin.qq.com/q/page', qrcode: 'payload-1' },
    [STATUS_ROUTE]: { errcode: 0, status: 'confirmed', bot_token: 'bot-token-1' },
  });
  await active.actions['weixin.qr-generate']?.({});
  const result = await active.actions['weixin.qr-status']?.({});
  assertOperationResultShape(result);
  assert.deepEqual(result, {
    render: 'status',
    data: { status: 'confirmed' },
    label: '已连接',
    targetValues: { botToken: 'bot-token-1' },
  });
  assert.deepEqual(fake.calls.connect, ['bot-token-1'], 'confirmed must establish the connection in-process');
  await active.stop();
});

test('disconnect stops polling in-process and clears the persisted target value', async () => {
  const { active, fake } = await activate({});
  const result = await active.actions['weixin.disconnect']?.({});
  assertOperationResultShape(result);
  assert.deepEqual(result, {
    render: 'status',
    data: { status: 'disconnected' },
    label: '已断开',
    targetValues: { botToken: '' },
  });
  assert.ok(fake.calls.disconnect, 'disconnect must tear down the connection in-process');
  await active.stop();
});

test('test action reports connected only when a token is adopted and polling is live', async () => {
  const { active, fake } = await activate({});
  const disconnected = await active.actions['weixin.test']?.({});
  assert.deepEqual(disconnected, { ok: false, message: '微信未连接（需要扫码登录）' });
  await active.actions['weixin.disconnect']?.({});
  fake.runtime.connect?.('x');
  const connected = await active.actions['weixin.test']?.({});
  assert.deepEqual(connected, { ok: true });
  await active.stop();
});

test('runtime starts idle without credentials and connects polling in-process once a token arrives', async () => {
  let polls = 0;
  let starts = 0;
  let stops = 0;
  let token = '';
  const adapter = {
    connectorId: 'weixin',
    hasBotToken: () => token !== '',
    isPolling: () => polls > 0,
    setBotToken(value: string) { token = value; },
    async disconnect() { token = ''; polls = 0; stops += 1; },
    async restoreSessionState() {},
    startPolling() { starts += 1; polls += 1; },
    async stopPolling() { stops += 1; },
    async sendReply() {},
    async sendMedia() {},
  } as unknown as WeixinRuntimeAdapter;
  const runtime: WeixinConnectorRuntime<WeixinRuntimeAdapter> = createWeixinConnectorRuntime({
    config: { botToken: '' },
    state: sessionState,
    logger,
    host: { deliver: async () => {} },
    createAdapter: (value) => { token = value; return adapter; },
  });
  await runtime.start();
  assert.equal(polls, 0, 'idle start must not begin provider polling');
  await runtime.connect('bot-token-2');
  assert.equal(polls, 1, 'connect must start polling in-process');
  assert.equal(runtime.isConnected(), true);
  await runtime.disconnect();
  assert.equal(stops, 1, 'disconnect must stop polling');
  assert.equal(runtime.isConnected(), false);
  assert.throws(() => runtime.outbound, /not connected/i);
  await runtime.connect('bot-token-3');
  assert.equal(starts, 2, 'a reconnect after disconnect must begin polling again (Host write-back does not restart the plugin)');
  assert.equal(runtime.isConnected(), true);
  await runtime.disconnect();
  await runtime.stop();
});

test('runtime outbound throws a clear error while unconfigured instead of swallowing sends', async () => {
  let polls = 0;
  const adapter = {
    connectorId: 'weixin',
    hasBotToken: () => false,
    isPolling: () => false,
    setBotToken() {},
    async restoreSessionState() {},
    startPolling() { polls += 1; },
    async stopPolling() {},
    async sendReply() {},
    async sendMedia() {},
  } as unknown as WeixinRuntimeAdapter;
  const runtime = createWeixinConnectorRuntime({
    config: { botToken: '' },
    state: sessionState,
    logger,
    host: { deliver: async () => {} },
    createAdapter: () => adapter,
  });
  await runtime.start();
  assert.throws(() => runtime.outbound.sendReply('chat-1', 'hello'), /not connected|扫码/i);
  await runtime.stop();
});

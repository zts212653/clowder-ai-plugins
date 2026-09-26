import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { ModulePluginHostShape } from '@clowder-ai/plugin-sdk';
import { parse } from 'yaml';

import { createWeComBotPluginModule } from './plugin-entrypoint.js';
import type { WeComBotConnectorRuntime } from './runtime.js';
import type { WeComBotAdapter } from './WeComBotAdapter.js';

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

function hostWith(values: Record<string, string>): ModulePluginHostShape {
  return {
    config: { get: async (key: string) => values[key] },
    secrets: { get: async (key: string) => values[key] },
    storage: {} as never,
    tasks: {} as never,
    media: { read: async input => ({ offset: input.offset, dataBase64: '', done: true }) },
    threads: { listBindings: async () => [{ key: 'chat-1', threadId: 'thread-1', createdAt: 1 }] } as never,
    messaging: {
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
      send: async (input: { threadId: string }) => ({ messageId: 'message-1', threadId: input.threadId }),
    },
    log() {},
  };
}

function fakeRuntime(calls: Record<string, unknown>) {
  const runtime = {
    async start() { (calls.start as unknown[] | undefined)?.push([]); },
    async stop() { (calls.stop as unknown[] | undefined)?.push([]); },
    async connect(config: unknown) { (calls.connect as unknown[] | undefined)?.push([config]); },
    async disconnect() { (calls.disconnect as unknown[] | undefined)?.push([]); },
    isConnected() { return calls.connected === true; },
    getConnectionState() { return calls.connected === true ? 'connected' : 'disconnected'; },
    get outbound() { throw new Error('not used in these tests'); },
  } as unknown as WeComBotConnectorRuntime<WeComBotAdapter>;
  return runtime;
}

test('manifest restores the wecom_validate operation with a validate → disconnect chain', async () => {
  const parsed = manifest as {
    configuration: Array<Record<string, unknown>>;
    test: { action: { method: string } };
  };
  const operation = parsed.configuration.find((item) => item.kind === 'operation');
  assert.ok(operation, 'wecom_validate operation must be declared');
  assert.equal(operation.key, 'wecom_validate');
  assert.deepEqual(operation.target, ['botId', 'botSecret']);
  assert.deepEqual(operation.actions, [
    { id: 'validate', label: '测试并连接', render: 'button', action: { method: 'wecom-bot.validate' }, next: 'disconnect' },
    { id: 'disconnect', label: '断开连接', render: 'button', action: { method: 'wecom-bot.disconnect' }, next: 'validate' },
  ]);
  assert.equal(parsed.test.action.method, 'wecom-bot.test');
  // Credentials are user-pasted, so the plugin must enable (healthy, idle) without them.
  const botId = parsed.configuration.find((item) => item.key === 'botId');
  const botSecret = parsed.configuration.find((item) => item.key === 'botSecret');
  assert.equal(botId?.required, false);
  assert.equal(botSecret?.required, false);
});

test('module starts healthy and idle without credentials', async () => {
  const calls: Record<string, unknown[][]> = { start: [] };
  const entrypoint = createWeComBotPluginModule(
    (options) => {
      assert.deepEqual(options.config, { botId: '', botSecret: '' });
      return fakeRuntime(calls);
    },
    async () => ({ valid: false }),
  );
  const active = await entrypoint.create(manifest).start(hostWith({}));
  assert.deepEqual(Object.keys(active.actions).sort(), [
    'host.messaging.lifecycle', 'wecom-bot.disconnect', 'wecom-bot.media-source.read', 'wecom-bot.media-source.settle', 'wecom-bot.outbound', 'wecom-bot.test', 'wecom-bot.validate',
  ]);
  await active.stop();
  assert.equal(calls.start?.length, 1);
});

test('validate without credentials is a terminal error and never touches the provider', async () => {
  let providerCalls = 0;
  const entrypoint = createWeComBotPluginModule(
    () => fakeRuntime({}),
    async () => { providerCalls += 1; return { valid: true }; },
  );
  const active = await entrypoint.create(manifest).start(hostWith({}));
  const result = await active.actions['wecom-bot.validate']?.({});
  assertOperationResultShape(result);
  assert.deepEqual(result, {
    render: 'status',
    data: { status: 'error', message: '未填写 Bot ID / Bot Secret — 在面板里填好，直接点测试并连接' },
    advance: false,
  });
  assert.equal(providerCalls, 0);
  await active.stop();
});

test('validate with rejected credentials stays on the action with the provider message', async () => {
  const entrypoint = createWeComBotPluginModule(
    () => fakeRuntime({}),
    async () => ({ valid: false, error: 'invalid botId' }),
  );
  const active = await entrypoint.create(manifest).start(hostWith({ botId: 'bot', botSecret: 'secret' }));
  const result = await active.actions['wecom-bot.validate']?.({});
  assertOperationResultShape(result);
  assert.deepEqual(result, {
    render: 'status',
    data: { status: 'error', message: 'invalid botId' },
    advance: false,
  });
  await active.stop();
});

test('validate with accepted credentials connects in-process and returns the target values', async () => {
  const calls: Record<string, unknown[][]> = { connect: [] };
  const entrypoint = createWeComBotPluginModule(
    () => fakeRuntime(calls),
    async (botId: string, secret: string) => {
      assert.equal(botId, 'bot');
      assert.equal(secret, 'secret');
      return { valid: true };
    },
  );
  const active = await entrypoint.create(manifest).start(hostWith({ botId: ' bot ', botSecret: ' secret ' }));
  const result = await active.actions['wecom-bot.validate']?.({});
  assertOperationResultShape(result);
  assert.deepEqual(result, {
    render: 'status',
    data: { status: 'confirmed' },
    label: '已连接',
    targetValues: { botId: 'bot', botSecret: 'secret' },
  });
  assert.deepEqual(calls.connect, [[{ botId: 'bot', botSecret: 'secret' }]]);
  await active.stop();
});

test('disconnect stops the stream in-process and clears the persisted target values', async () => {
  const calls: Record<string, unknown[][]> = { disconnect: [] };
  const entrypoint = createWeComBotPluginModule(() => fakeRuntime(calls), async () => ({ valid: true }));
  const active = await entrypoint.create(manifest).start(hostWith({ botId: 'bot', botSecret: 'secret' }));
  const result = await active.actions['wecom-bot.disconnect']?.({});
  assertOperationResultShape(result);
  assert.deepEqual(result, {
    render: 'status',
    data: { status: 'disconnected' },
    label: '已断开',
    targetValues: { botId: '', botSecret: '' },
  });
  assert.equal((calls.disconnect as unknown[] | undefined)?.length, 1);
  await active.stop();
});

test('test action reports connected only when the provider WebSocket is live', async () => {
  const calls: Record<string, unknown> = { connected: false };
  const entrypoint = createWeComBotPluginModule(() => fakeRuntime(calls), async () => ({ valid: true }));
  const active = await entrypoint.create(manifest).start(hostWith({ botId: 'bot', botSecret: 'secret' }));
  assert.deepEqual(await active.actions['wecom-bot.test']?.({}), {
    ok: false,
    message: '当前状态: disconnected',
  });
  calls.connected = true;
  assert.deepEqual(await active.actions['wecom-bot.test']?.({}), { ok: true });
  await active.stop();
});

test('validate prefers unsaved card input over stored values and returns them as targetValues', async () => {
  const calls: Record<string, unknown[][]> = { connect: [] };
  const entrypoint = createWeComBotPluginModule(
    () => fakeRuntime(calls),
    async (botId: string, secret: string) => {
      assert.equal(botId, 'input-bot');
      assert.equal(secret, 'input-secret');
      return { valid: true };
    },
  );
  const active = await entrypoint.create(manifest).start(hostWith({ botId: 'stored-bot', botSecret: 'stored-secret' }));
  const result = await active.actions['wecom-bot.validate']?.({
    input: { botId: ' input-bot ', botSecret: ' input-secret ' },
  });
  assertOperationResultShape(result);
  assert.deepEqual(result, {
    render: 'status',
    data: { status: 'confirmed' },
    label: '已连接',
    targetValues: { botId: 'input-bot', botSecret: 'input-secret' },
  });
  assert.deepEqual(calls.connect, [[{ botId: 'input-bot', botSecret: 'input-secret' }]]);
  await active.stop();
});

test('validate falls back to the adopted secret when input only carries botId', async () => {
  const entrypoint = createWeComBotPluginModule(
    () => fakeRuntime({}),
    async (botId: string, secret: string) => {
      assert.equal(botId, 'input-bot');
      assert.equal(secret, 'stored-secret');
      return { valid: true };
    },
  );
  const active = await entrypoint.create(manifest).start(hostWith({ botId: 'stored-bot', botSecret: 'stored-secret' }));
  await active.actions['wecom-bot.validate']?.({ input: { botId: 'input-bot' } });
  await active.stop();
});

test('disconnect clears adopted credentials so an empty-input validate cannot silently reconnect', async () => {
  const calls: Record<string, unknown[][]> = { connect: [], disconnect: [] };
  let providerCalls = 0;
  const entrypoint = createWeComBotPluginModule(
    () => fakeRuntime(calls),
    async (botId: string, secret: string) => {
      providerCalls += 1;
      assert.equal(botId, 'bot');
      assert.equal(secret, 'secret');
      return { valid: true };
    },
  );
  // Host stores nothing: the only credentials in play are the card input.
  const active = await entrypoint.create(manifest).start(hostWith({}));
  const first = await active.actions['wecom-bot.validate']?.({ input: { botId: 'bot', botSecret: 'secret' } });
  assertOperationResultShape(first);
  assert.deepEqual(first.data, { status: 'confirmed' });
  assert.equal(providerCalls, 1);
  await active.actions['wecom-bot.disconnect']?.({});
  const second = await active.actions['wecom-bot.validate']?.({});
  assertOperationResultShape(second);
  assert.deepEqual(second, {
    render: 'status',
    data: { status: 'error', message: '未填写 Bot ID / Bot Secret — 在面板里填好，直接点测试并连接' },
    advance: false,
  });
  assert.equal(providerCalls, 1, 'provider validation must not run after disconnect');
  assert.equal(calls.connect.length, 1, 'runtime.connect must not run after disconnect');
  await active.stop();
});

test('empty-input validate after disconnect must not fall back to the activation-time snapshot', async () => {
  const calls: Record<string, unknown[][]> = { connect: [], disconnect: [] };
  let providerCalls = 0;
  const entrypoint = createWeComBotPluginModule(
    () => fakeRuntime(calls),
    async () => { providerCalls += 1; return { valid: true }; },
  );
  // Real steady state: last validate persisted credentials, so the Host
  // hands them to activate() — the snapshot still holds them after the
  // owner disconnects and Host writes '' back without restarting the plugin.
  const active = await entrypoint.create(manifest).start(hostWith({ botId: 'stored-bot', botSecret: 'stored-secret' }));
  await active.actions['wecom-bot.validate']?.({});
  assert.equal(providerCalls, 1);
  await active.actions['wecom-bot.disconnect']?.({});
  const empty = await active.actions['wecom-bot.validate']?.({});
  assertOperationResultShape(empty);
  assert.deepEqual(empty, {
    render: 'status',
    data: { status: 'error', message: '未填写 Bot ID / Bot Secret — 在面板里填好，直接点测试并连接' },
    advance: false,
  });
  assert.equal(providerCalls, 1, 'snapshot credentials must not reach the provider after disconnect');
  assert.equal(calls.connect.length, 1, 'runtime.connect must not run with snapshot credentials after disconnect');
  // Fresh card input still wins and is written back as the target values.
  const fresh = await active.actions['wecom-bot.validate']?.({ input: { botId: 'new-bot', botSecret: 'new-secret' } });
  assertOperationResultShape(fresh);
  assert.deepEqual(fresh, {
    render: 'status',
    data: { status: 'confirmed' },
    label: '已连接',
    targetValues: { botId: 'new-bot', botSecret: 'new-secret' },
  });
  assert.equal(providerCalls, 2);
  assert.equal(calls.connect.length, 2, 'first validate adopts the stored snapshot, fresh input validates again');
  assert.deepEqual(calls.connect[1], [{ botId: 'new-bot', botSecret: 'new-secret' }]);
  await active.stop();
});

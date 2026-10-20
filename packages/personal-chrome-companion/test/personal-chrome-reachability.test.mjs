import assert from 'node:assert/strict';
import { createServer, Socket } from 'node:net';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHook } from 'node:async_hooks';

import { createConversationHostOperations } from '../src/conversation-host.js';
import { createAuthorizationOperations } from '../src/plugin-entrypoint.js';
import { createNativeHostBridge } from '../native-host/native-host.mjs';

const require = createRequire(import.meta.url);
const contractRequire = createRequire(import.meta.resolve('@clowder-ai/plugin-contract'));
const Ajv = contractRequire('ajv/dist/2020');
const ajv = new Ajv({ allErrors: true, strict: false });
contractRequire('ajv-formats')(ajv);
for (const name of ['plugin-metadata', 'signals', 'messaging', 'manifest']) {
  ajv.addSchema(JSON.parse(readFileSync(require.resolve(`@clowder-ai/plugin-contract/schemas/${name}`), 'utf8')));
}
const manifestSchema = JSON.parse(readFileSync(require.resolve('@clowder-ai/plugin-contract/schemas/manifest'), 'utf8'));
const validateStatus = ajv.getSchema(`${manifestSchema.$id}#/$defs/OperationActionResult`);
const secret = 'a'.repeat(64);
const revisions = { helper: `sha512:${'0'.repeat(128)}`, extension: '0.2.11', pageAdapter: '2026-09-02.1' };
const appendInput = { conversationId: 'conv-1', text: 'hello', idempotencyKey: 'delivery-1' };
const ackInput = { conversationId: 'conv-1', sourceMessageId: 'delivery-1', assistantMessageId: 'turn-2' };

async function fixture(t, { paired = true, timeoutMs = 5_000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'p2c-'));
  const socketPath = join(root, 'host.sock');
  const logs = [];
  let time = 1_800_000_000_000;
  const connect = t.mock.method(Socket.prototype, 'connect');
  const operations = createConversationHostOperations({
    dataDirectory: root, timeoutMs, now: () => time,
    log: (...args) => logs.push(args),
  });
  const authorization = createAuthorizationOperations({
    authorizationPath: join(root, 'conversation-binding.json'),
    helperStatus: () => operations.status(),
  });
  const servers = [];
  t.after(async () => {
    await operations.dispose();
    for (const close of servers) await close();
    await rm(root, { recursive: true, force: true });
  });
  async function pair() {
    await writeFile(join(root, 'pairing.json'), JSON.stringify({
      schemaVersion: 1, extensionId: 'a'.repeat(32), socketPath,
      ledgerPath: join(root, 'ledger.json'), pairingSecret: secret,
      artifactDigest: revisions.helper,
      installedAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z',
    }), { mode: 0o600 });
  }
  if (paired) await pair();
  async function startHelper() {
    await writeFile(join(root, 'conversation-binding.json'), JSON.stringify({
      schemaVersion: 1, provider: 'chatgpt', conversationId: 'conv-1',
      chatUrl: 'https://chatgpt.com/c/conv-1',
      boundAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z',
    }), { mode: 0o600 });
    const bridge = await createNativeHostBridge({
      socketPath, ledgerPath: join(root, 'ledger.json'),
      conversationBindingPath: join(root, 'conversation-binding.json'),
      pairingSecret: secret, helperArtifactRevision: revisions.helper,
      sendNative: async (request) => {
        if (request.kind === 'health_check') {
          await bridge.acceptNativeMessage({ v: 2, kind: 'health_result', requestId: request.requestId,
            status: 'ready', observedRevisions: revisions });
        } else if (request.kind === 'append_message') {
          await bridge.acceptNativeMessage({ v: 2, kind: 'append_progress', requestId: request.requestId,
            idempotencyKey: request.idempotencyKey, status: 'submitted', observedRevisions: revisions });
          await bridge.acceptNativeMessage({ v: 2, kind: 'append_result', requestId: request.requestId,
            idempotencyKey: request.idempotencyKey, status: 'host_observed',
            hostMessageId: 'turn-1', observedRevisions: revisions });
        }
      },
    });
    servers.push(() => bridge.stop());
    return bridge;
  }
  async function startWire(onRequest) {
    const sockets = new Set();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      socket.once('data', (data) => onRequest(socket, JSON.parse(data.toString()).request));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    servers.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    });
    return sockets;
  }
  async function status(state) {
    const before = connect.mock.callCount();
    const result = await authorization.status();
    assert.equal(validateStatus(result), true, JSON.stringify(validateStatus.errors));
    assert.equal(result.data.helper.state, state);
    assert.match(result.label, new RegExp(`Helper: ${state}`), 'helper state must appear in the Host-rendered label');
    assert.equal(typeof result.data.authorizedCount, 'number');
    assert.equal(result.data.authorizationLimit, 32);
    assert.equal(connect.mock.callCount(), before, 'status must never connect');
    return result.data.helper;
  }
  return { root, operations, authorization, logs, connect, pair, startHelper, startWire, status,
    now: () => time, advance: (ms) => { time += ms; } };
}

test('list gates real connection attempts for 2/4/8/16/32/60/60 seconds and logs one transition', async (t) => {
  const f = await fixture(t);
  for (const seconds of [2, 4, 8, 16, 32, 60, 60]) {
    const before = f.connect.mock.callCount();
    assert.deepEqual(await f.operations.list({}), { returns: [] });
    assert.equal(f.connect.mock.callCount(), before + 1);
    f.advance(seconds * 1000 - 1);
    assert.deepEqual(await f.operations.list({}), { returns: [] });
    assert.equal(f.connect.mock.callCount(), before + 1, 'no socket attempt inside backoff');
    f.advance(1);
  }
  const state = await f.status('unreachable');
  assert.equal(state.consecutiveFailures, 7);
  assert.equal(state.nextListAttemptAt, f.now());
  assert.equal(state.since, 1_800_000_000_000);
  assert.deepEqual(f.logs.map(([level]) => level), ['warn']);
  assert.ok(!JSON.stringify(f.logs).includes(secret));
  assert.ok(!JSON.stringify(f.logs).includes(f.root));
});

test('next permitted list connects to the real helper and resets the next outage to 2s', async (t) => {
  const f = await fixture(t);
  await f.operations.list({}); f.advance(2000);
  await f.operations.list({}); f.advance(4000);
  const helper = await f.startHelper();
  await f.operations.list({});
  assert.equal((await f.status('connected')).lastContactAt, f.now());
  assert.deepEqual(f.logs.map(([level]) => level), ['warn', 'info']);
  await helper.stop();
  await f.operations.list({});
  const state = await f.status('unreachable');
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(state.nextListAttemptAt, f.now() + 2000);
});

for (const action of ['appendMessage', 'ack', 'probe']) {
  test(`${action} bypasses list backoff and an accepted connection resumes list immediately`, async (t) => {
    const f = await fixture(t);
    await f.operations.list({});
    await f.startHelper();
    const before = f.connect.mock.callCount();
    const result = await f.operations[action](action === 'appendMessage' ? appendInput : ackInput);
    assert.equal(f.connect.mock.callCount(), before + 1);
    if (action === 'appendMessage') assert.equal(result.status, 'appended');
    if (action === 'probe') assert.equal(result.ok, true);
    if (action === 'ack') assert.equal(result.errorCode, 'ASSISTANT_RETURN_NOT_FOUND');
    await f.status('connected');
    await f.operations.list({});
    assert.equal(f.connect.mock.callCount(), before + 2);
  });
}

test('failed probe attempts a connection but does not clear unavailable backoff', async (t) => {
  const f = await fixture(t);
  await f.operations.list({});
  assert.equal((await f.operations.probe()).ok, false);
  assert.equal(f.connect.mock.callCount(), 2);
  await f.operations.list({});
  assert.equal(f.connect.mock.callCount(), 2);
  await f.status('unreachable');
  assert.deepEqual(f.logs.map(([level]) => level), ['warn']);
});

for (const mode of ['fin', 'timeout', 'host-unavailable-receipt']) {
  test(`post-connect ${mode} is not a pre-send failure and cannot activate backoff`, async (t) => {
    const f = await fixture(t, { timeoutMs: 100 });
    await f.operations.list({});
    await f.startWire((socket, request) => {
      if (mode === 'fin') socket.end();
      if (mode === 'host-unavailable-receipt') socket.end(JSON.stringify({
        v: 2, kind: 'append_result', requestId: request.requestId,
        idempotencyKey: request.idempotencyKey, status: 'failed', errorCode: 'HOST_UNAVAILABLE',
      }) + '\n');
    });
    const result = await f.operations.appendMessage(appendInput);
    assert.equal(result.errorCode, mode === 'host-unavailable-receipt' ? 'HOST_UNAVAILABLE' : 'AMBIGUOUS_EFFECT');
    await f.status('connected');
    const before = f.connect.mock.callCount();
    await f.operations.list({});
    assert.equal(f.connect.mock.callCount(), before + 1);
    await f.status('connected');
  });
}

test('status preserves authorization fields, reports unknown/not_installed, and guides installation', async (t) => {
  const f = await fixture(t, { paired: false });
  await f.status('unknown');
  await f.operations.list({});
  const absent = await f.status('not_installed');
  assert.match(absent.guidance, /Settings.*Chrome connection/);
  assert.equal(f.connect.mock.callCount(), 0);
  await f.operations.list({});
  assert.deepEqual(f.logs.map(([level]) => level), ['warn']);
  await f.pair(); await f.startHelper();
  assert.equal((await f.operations.probe()).ok, true);
  await f.status('connected');
  assert.deepEqual(f.logs.map(([level]) => level), ['warn', 'info']);
});

for (const action of ['list', 'appendMessage', 'ack', 'probe']) {
  test(`${action} exposes invalid installation, logs once and recovers without backoff`, async (t) => {
    const f = await fixture(t);
    // Exercise both an initial unknown status and a previously successful contact.
    if (action === 'appendMessage') {
      await f.startHelper();
      await f.operations.list({});
      await f.status('connected');
      f.logs.length = 0;
    }
    await writeFile(join(f.root, 'pairing.json'), JSON.stringify({ privateValue: secret }));
    const input = action === 'appendMessage' ? appendInput : ackInput;
    const result = await f.operations[action](input);
    if (action === 'appendMessage' || action === 'ack') assert.equal(result.errorCode, 'INVALID_CONFIGURATION');
    const state = await f.status('invalid_installation');
    assert.equal(state.since, f.now());
    assert.equal('nextListAttemptAt' in state, false);
    assert.match(state.guidance, /pairing record validation failed/i);
    assert.match(state.guidance, /Settings.*Chrome connection/i);
    const label = (await f.authorization.status()).label;
    assert.match(label, /installation is broken/i);
    assert.match(label, /pairing record validation failed/i);
    const before = f.connect.mock.callCount();
    f.advance(1);
    await f.operations[action](input);
    await f.operations.list({});
    assert.equal((await f.status('invalid_installation')).since, state.since);
    assert.equal(f.connect.mock.callCount(), before, 'invalid records never open a socket');
    assert.deepEqual(f.logs.map(([level]) => level), ['warn']);
    assert.ok(!JSON.stringify({ state, label, logs: f.logs }).includes(secret));
    assert.ok(!JSON.stringify({ state, label, logs: f.logs }).includes('privateValue'));
    await f.pair();
    if (action !== 'appendMessage') await f.startHelper();
    await f.operations.list({});
    await f.status('connected');
    assert.equal(f.connect.mock.callCount(), before + 1, 'repair is attempted immediately without backoff');
    assert.deepEqual(f.logs.map(([level]) => level), ['warn', 'info']);
  });
}

for (const corruption of ['permissions', 'oversized', 'malformed-json']) {
  test(`pairing ${corruption} failure reports invalid installation without contents`, async (t) => {
    const f = await fixture(t);
    const path = join(f.root, 'pairing.json');
    if (corruption === 'permissions') await chmod(path, 0o644);
    if (corruption === 'oversized') await writeFile(path, secret.repeat(300));
    if (corruption === 'malformed-json') await writeFile(path, '{' + secret);
    await f.operations.list({});
    const state = await f.status('invalid_installation');
    assert.equal(f.connect.mock.callCount(), 0);
    assert.ok(!JSON.stringify(state).includes(secret));
  });
}

test('dispose cancels live requests, clears status, and leaves no client sockets or retry timers', async (t) => {
  const f = await fixture(t);
  const sockets = await f.startWire(() => {});
  const timers = new Set();
  const hook = createHook({
    init: (id, type) => { if (type === 'Timeout') timers.add(id); },
    destroy: (id) => timers.delete(id),
  }).enable();
  t.after(() => hook.disable());
  const pending = f.operations.appendMessage(appendInput);
  while (sockets.size === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.size, 1, 'only the request deadline is armed');
  await f.operations.dispose();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sockets.size, 0);
  assert.deepEqual(f.operations.status(), { state: 'unknown' });
  const before = f.connect.mock.callCount();
  await f.operations.list({}); await f.operations.probe();
  assert.equal(f.connect.mock.callCount(), before);
  assert.ok(f.connect.mock.calls.every(({ this: socket }) => socket.destroyed));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.size, 0, 'stop leaves no request or retry timers');
});

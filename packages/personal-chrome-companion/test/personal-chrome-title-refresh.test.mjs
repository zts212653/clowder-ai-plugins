import assert from 'node:assert/strict';
import { createServer, Socket } from 'node:net';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { createConversationHostOperations } from '../src/conversation-host.js';
import { createNativeHostBridge } from '../native-host/native-host.mjs';
import { authorizePersonalChromeConversation } from '../native-host/conversation-binding.mjs';
import { readConversationTitles } from '../native-host/conversation-titles.mjs';

const revision = `sha512:${'0'.repeat(128)}`;
const secret = 'a'.repeat(64);
const synced = { status: 'synced', updatedCount: 1, requestedCount: 1 };
const unavailable = (errorCode) => ({ status: 'unavailable', errorCode });

async function fixture(t, { paired = true, timeoutMs = 1000, onRevisionContact } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'p2e-'));
  const socketPath = join(root, 'host.sock');
  const ledgerPath = join(root, 'ledger.json');
  const conversationBindingPath = join(root, 'conversation-binding.json');
  const operations = createConversationHostOperations({ dataDirectory: root, timeoutMs, now: () => 1000, onRevisionContact });
  const cleanups = [];
  t.after(async () => {
    await operations.dispose();
    for (const cleanup of cleanups.reverse()) await cleanup();
    await rm(root, { recursive: true, force: true });
  });
  const pair = async (pairingSecret = secret) => writeFile(join(root, 'pairing.json'), JSON.stringify({
    schemaVersion: 1, extensionId: 'a'.repeat(32), socketPath, ledgerPath, pairingSecret,
    artifactDigest: revision, installedAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z',
  }), { mode: 0o600 });
  if (paired) await pair();
  const helper = async ({ invalidTitles = false, helperRevision = revision } = {}) => {
    await authorizePersonalChromeConversation(conversationBindingPath, {
      conversationId: 'one', chatUrl: 'https://chatgpt.com/c/one',
      authorizedAt: '2026-09-30T00:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z',
    });
    const bridge = await createNativeHostBridge({
      socketPath, ledgerPath, conversationBindingPath, pairingSecret: secret, helperArtifactRevision: helperRevision,
      sendNative: async (message) => {
        if (message.kind === 'conversation_title_request') await bridge.acceptNativeMessage({
          v: 1, kind: 'conversation_title_result', requestId: message.requestId,
          titles: [{ conversationId: invalidTitles ? 'unauthorized' : 'one', displayTitle: 'A readable title' }],
        });
      },
    });
    cleanups.push(() => bridge.stop());
  };
  const peer = async (reply) => {
    const sockets = new Set();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      let input = '';
      socket.on('data', (bytes) => {
        input += bytes;
        if (input.includes('\n')) { socket.removeAllListeners('data'); reply(socket, JSON.parse(input).request); }
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  };
  assert.equal(typeof operations.refreshTitles, 'function');
  return { operations, pair, helper, peer, conversationBindingPath };
}

test('refresh sends the real helper request and persists synced title counts', async (t) => {
  const f = await fixture(t);
  await f.helper();
  assert.deepEqual(await f.operations.refreshTitles(), synced);
  assert.equal((await readConversationTitles(f.conversationBindingPath))[0].displayTitle, 'A readable title');
});

test('owner refresh bypasses missing-installation backoff and connection resets list backoff', async (t) => {
  const f = await fixture(t, { paired: false });
  assert.deepEqual(await f.operations.refreshTitles(), unavailable('HOST_UNAVAILABLE'));
  await f.pair(); await f.helper();
  const connect = t.mock.method(Socket.prototype, 'connect');
  await f.operations.list({});
  assert.equal(connect.mock.callCount(), 0);
  assert.deepEqual(await f.operations.refreshTitles(), synced);
  await f.operations.list({});
  assert.equal(connect.mock.callCount(), 2);
});

test('real helper pairing rejection survives its invalid-request receipt ID', async (t) => {
  const f = await fixture(t); await f.helper(); await f.pair('b'.repeat(64));
  assert.deepEqual(await f.operations.refreshTitles(), unavailable('PAIRING_REJECTED'));
});

test('real helper unavailable result is preserved', async (t) => {
  const f = await fixture(t); await f.helper({ invalidTitles: true });
  assert.deepEqual(await f.operations.refreshTitles(), unavailable('INVALID_TITLE_RESPONSE'));
});

test('stale helper receipt is preserved and informs delivery without clearing revision evidence', async (t) => {
  const observed = [];
  const f = await fixture(t, { onRevisionContact: async (...args) => observed.push(args) });
  await f.helper({ helperRevision: `sha512:${'1'.repeat(128)}` });
  assert.deepEqual(await f.operations.refreshTitles(), unavailable('STALE_HELPER'));
  assert.deepEqual(observed, [[undefined, 'STALE_HELPER']]);
});

for (const fault of ['eof', 'timeout', 'forged', 'counts', 'protocol', 'unavailable', 'bad-json', 'oversize']) {
  test(`post-write ${fault} is ambiguous, never HOST_UNAVAILABLE`, async (t) => {
    const f = await fixture(t, { timeoutMs: 200 });
    await f.peer((socket, request) => {
      if (fault === 'eof') return socket.end();
      if (fault === 'timeout') return;
      if (fault === 'bad-json') return socket.end('{broken}\n');
      if (fault === 'oversize') return socket.end(`${'x'.repeat(256 * 1024)}\n`);
      const response = { v: 1, kind: 'conversation_titles_refreshed', requestId: request.requestId, ...synced };
      if (fault === 'forged') response.requestId = 'wrong-request';
      if (fault === 'counts') response.updatedCount = 2;
      if (fault === 'protocol') response.v = 2;
      if (fault === 'unavailable') Object.assign(response, unavailable('HOST_UNAVAILABLE'));
      socket.end(`${JSON.stringify(response)}\n`);
    });
    assert.deepEqual(await f.operations.refreshTitles(), unavailable('AMBIGUOUS_EFFECT'));
  });
}

test('stop during pairing resolution and calls after stop never create sockets', async (t) => {
  const f = await fixture(t);
  const connect = t.mock.method(Socket.prototype, 'connect');
  const pending = f.operations.refreshTitles();
  await f.operations.dispose();
  assert.deepEqual(await pending, unavailable('HOST_UNAVAILABLE'));
  assert.deepEqual(await f.operations.refreshTitles(), unavailable('HOST_UNAVAILABLE'));
  assert.equal(connect.mock.callCount(), 0);
});

test('stop cancels a written refresh without claiming no effect', async (t) => {
  const f = await fixture(t, { timeoutMs: 5000 });
  let received;
  const frame = new Promise((resolve) => { received = resolve; });
  await f.peer(() => received());
  const pending = f.operations.refreshTitles();
  await frame; await f.operations.dispose();
  assert.deepEqual(await pending, unavailable('AMBIGUOUS_EFFECT'));
});

test('manifest exposes refresh-titles as an owner button followed by list', async () => {
  const manifest = parse(await readFile(new URL('../plugin.yaml', import.meta.url), 'utf8'));
  const operation = manifest.configuration.find((item) => item.key === 'personalChromeAuthorizations');
  const action = operation.actions.find((item) => item.id === 'refresh-titles');
  assert.equal(action?.render, 'button');
  assert.equal(action?.action.method, 'personal-chrome-host.authorizations.refresh-titles');
  assert.equal(action?.next, 'list');
});

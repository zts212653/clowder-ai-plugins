import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NativeMessageDecoder, encodeNativeMessage } from '../native-host/native-framing.mjs';
import {
  assertSupportedPlatform,
  createNativeHostBridge,
  resolveNativeHostConfiguration,
} from '../native-host/native-host.mjs';

function requestOverLocalSocket(socketPath, envelope) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify(envelope)}\n`));
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.once('error', reject);
    socket.once('end', () => resolve(JSON.parse(response)));
  });
}

test('native framing round-trips only complete object messages', () => {
  const frame = encodeNativeMessage({ v: 1, kind: 'query_binding', requestId: 'query-1' });
  const decoder = new NativeMessageDecoder();
  assert.deepEqual(decoder.push(frame.subarray(0, 2)), []);
  assert.deepEqual(decoder.push(frame.subarray(2)), [{ v: 1, kind: 'query_binding', requestId: 'query-1' }]);
  decoder.finish();
  assert.throws(() => encodeNativeMessage('not-an-object'));
});

test('helper is POSIX-only and accepts only complete Host-supplied configuration', async () => {
  assert.throws(() => assertSupportedPlatform('win32'), /Windows is unsupported/);
  assert.doesNotThrow(() => assertSupportedPlatform('darwin'));
  assert.deepEqual(
    await resolveNativeHostConfiguration({
      platform: 'darwin',
      env: {
        CAT_CAFE_PERSONAL_CHROME_SOCKET: '/tmp/f247.sock',
        CAT_CAFE_PERSONAL_CHROME_LEDGER: '/tmp/f247-ledger.json',
        CAT_CAFE_PERSONAL_CHROME_PAIRING_SECRET: 'A'.repeat(43),
      },
      argv: [],
    }),
    {
      socketPath: '/tmp/f247.sock',
      ledgerPath: '/tmp/f247-ledger.json',
      conversationBindingPath: '/tmp/conversation-binding.json',
      pairingSecret: 'A'.repeat(43),
    },
  );
  await assert.rejects(
    resolveNativeHostConfiguration({ platform: 'darwin', env: {}, argv: [] }),
    /required personal Chrome host configuration is missing/,
  );
  await assert.rejects(
    resolveNativeHostConfiguration({
      platform: 'darwin',
      env: {
        CAT_CAFE_PERSONAL_CHROME_SOCKET: 'relative.sock',
        CAT_CAFE_PERSONAL_CHROME_LEDGER: '/tmp/f247-ledger.json',
        CAT_CAFE_PERSONAL_CHROME_PAIRING_SECRET: 'A'.repeat(43),
      },
      argv: [],
    }),
    /socketPath must be absolute/,
  );
});

test('explicit binding gates dispatch, preserves real Host receipt, and replays the terminal idempotency result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f247-native-host-'));
  const socketPath = join(root, 'host.sock');
  const ledgerPath = join(root, 'ledger.json');
  const conversationBindingPath = join(root, 'conversation-binding.json');
  const pairingSecret = 'A'.repeat(43);
  const nativeMessages = [];
  const bridge = await createNativeHostBridge({
    socketPath,
    ledgerPath,
    conversationBindingPath,
    pairingSecret,
    now: () => new Date('2026-08-21T16:18:00.000Z'),
    sendNative: async (message) => nativeMessages.push(message),
  });

  try {
    await bridge.acceptNativeMessage({
      v: 1,
      kind: 'bind_conversation',
      requestId: 'binding-1',
      conversationId: 'conversation-1',
      chatUrl: 'https://chatgpt.com/c/conversation-1',
    });
    assert.deepEqual(nativeMessages.shift(), {
      v: 1,
      kind: 'binding_result',
      requestId: 'binding-1',
      status: 'bound',
      conversationId: 'conversation-1',
      boundAt: '2026-08-21T16:18:00.000Z',
    });
    assert.equal((await readFile(conversationBindingPath, 'utf8')).includes('conversation-1'), true);

    const append = {
      v: 1,
      kind: 'append_message',
      requestId: 'append-1',
      conversationId: 'conversation-1',
      text: 'one real append',
      idempotencyKey: 'delivery-1',
    };
    const firstReply = requestOverLocalSocket(socketPath, { pairingSecret, request: append });
    await bridge.waitForDispatchCount(1);
    assert.deepEqual(nativeMessages.shift(), append);
    await bridge.acceptNativeMessage({
      v: 1,
      kind: 'append_result',
      requestId: 'append-1',
      idempotencyKey: 'delivery-1',
      status: 'host_observed',
      hostMessageId: 'message-1',
    });
    assert.deepEqual(await firstReply, {
      v: 1,
      kind: 'append_result',
      requestId: 'append-1',
      idempotencyKey: 'delivery-1',
      status: 'host_observed',
      hostMessageId: 'message-1',
    });

    assert.deepEqual(
      await requestOverLocalSocket(socketPath, {
        pairingSecret,
        request: { ...append, requestId: 'append-retry-1' },
      }),
      {
        v: 1,
        kind: 'append_result',
        requestId: 'append-retry-1',
        idempotencyKey: 'delivery-1',
        status: 'host_observed',
        hostMessageId: 'message-1',
      },
    );
    assert.equal(nativeMessages.length, 0, 'a terminal retry must not dispatch a second append');
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

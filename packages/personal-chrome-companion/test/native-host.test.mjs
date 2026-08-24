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

async function settledWithin(promise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
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

test('rejects a concurrent requestId collision without corrupting either append admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f247-native-host-'));
  const socketPath = join(root, 'host.sock');
  const ledgerPath = join(root, 'ledger.json');
  const conversationBindingPath = join(root, 'conversation-binding.json');
  const pairingSecret = 'A'.repeat(43);
  const nativeMessages = [];
  let releaseFirstPersist;
  const firstPersistStarted = new Promise((resolve) => {
    releaseFirstPersist = resolve;
  });
  let allowFirstPersist;
  const firstPersistAllowed = new Promise((resolve) => {
    allowFirstPersist = resolve;
  });
  const bridge = await createNativeHostBridge({
    socketPath,
    ledgerPath,
    conversationBindingPath,
    pairingSecret,
    now: () => new Date('2026-08-21T16:18:00.000Z'),
    sendNative: async (message) => nativeMessages.push(message),
    writeLedger: async (path, entries) => {
      if (entries.has('conversation-1\u0000delivery-1')) {
        releaseFirstPersist();
        await firstPersistAllowed;
      }
      const { writeAtomicLedger } = await import('../native-host/native-ledger.mjs');
      return writeAtomicLedger(path, entries);
    },
  });

  try {
    await bridge.acceptNativeMessage({
      v: 1,
      kind: 'bind_conversation',
      requestId: 'binding-1',
      conversationId: 'conversation-1',
      chatUrl: 'https://chatgpt.com/c/conversation-1',
    });
    nativeMessages.length = 0;

    const firstAppend = {
      v: 1,
      kind: 'append_message',
      requestId: 'shared-request-id',
      conversationId: 'conversation-1',
      text: 'first append',
      idempotencyKey: 'delivery-1',
    };
    const secondAppend = {
      ...firstAppend,
      text: 'second append',
      idempotencyKey: 'delivery-2',
    };
    const firstReply = requestOverLocalSocket(socketPath, { pairingSecret, request: firstAppend });
    await firstPersistStarted;
    const secondReply = requestOverLocalSocket(socketPath, { pairingSecret, request: secondAppend });
    assert.deepEqual(await settledWithin(secondReply, 250), {
      v: 1,
      kind: 'append_result',
      requestId: 'shared-request-id',
      idempotencyKey: 'delivery-2',
      status: 'failed',
      errorCode: 'REQUEST_ID_CONFLICT',
    });

    allowFirstPersist();
    await bridge.waitForDispatchCount(1);
    assert.deepEqual(nativeMessages.shift(), firstAppend);
    await bridge.acceptNativeMessage({
      v: 1,
      kind: 'append_result',
      requestId: 'shared-request-id',
      idempotencyKey: 'delivery-1',
      status: 'host_observed',
      hostMessageId: 'message-1',
    });
    assert.deepEqual(await firstReply, {
      v: 1,
      kind: 'append_result',
      requestId: 'shared-request-id',
      idempotencyKey: 'delivery-1',
      status: 'host_observed',
      hostMessageId: 'message-1',
    });
  } finally {
    allowFirstPersist?.();
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('serializes consecutive conversation bindings so the latest native input remains persisted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f247-native-host-'));
  const socketPath = join(root, 'host.sock');
  const ledgerPath = join(root, 'ledger.json');
  const conversationBindingPath = join(root, 'conversation-binding.json');
  const writes = [];
  const bridge = await createNativeHostBridge({
    socketPath,
    ledgerPath,
    conversationBindingPath,
    pairingSecret: 'A'.repeat(43),
    now: () => new Date('2026-08-21T16:18:00.000Z'),
    writeConversationBinding: async (_path, record) => {
      if (record.conversationId === 'older-conversation') {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      writes.push(record);
      return record;
    },
    sendNative: async () => undefined,
  });

  try {
    await Promise.all([
      bridge.acceptNativeMessage({
        v: 1,
        kind: 'bind_conversation',
        requestId: 'binding-older',
        conversationId: 'older-conversation',
        chatUrl: 'https://chatgpt.com/c/older-conversation',
      }),
      bridge.acceptNativeMessage({
        v: 1,
        kind: 'bind_conversation',
        requestId: 'binding-latest',
        conversationId: 'latest-conversation',
        chatUrl: 'https://chatgpt.com/c/latest-conversation',
      }),
    ]);

    assert.equal(writes.at(-1).conversationId, 'latest-conversation');
  } finally {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  }
});

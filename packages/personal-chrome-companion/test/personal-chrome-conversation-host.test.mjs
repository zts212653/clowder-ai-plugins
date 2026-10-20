// p2b real-seam tests: the cloud-conversation-host methods talk to the
// package's own native-host helper over a real Unix socket, exactly the way the
// Host transport does. The pairing record is hand-written into a temp data
// directory, mirroring what the install-host CLI writes (contract h2).
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  isCloudConversationAckResult,
  isCloudConversationAppendMessageResult,
  isCloudConversationListResult,
} from '@clowder-ai/plugin-contract';

import { createConversationHostOperations } from '../src/conversation-host.js';
import { createNativeHostBridge as createNativeHostBridgeImpl } from '../native-host/native-host.mjs';

const helperArtifactRevision = `sha512:${'0'.repeat(128)}`;
const REVISIONS = {
  helper: helperArtifactRevision,
  extension: '0.2.11',
  pageAdapter: '2026-09-02.1',
};
const CONVERSATION_ID = 'conversation-7';
const SOURCE_MESSAGE_ID = 'source-message-9';
const HOST_MESSAGE_ID = 'conversation-turn-41';
const ASSISTANT_MESSAGE_ID = 'conversation-turn-42';
const PAIRING_SECRET = 'a'.repeat(64);

// Answers the helper's native dispatch the way the extension page adapter
// would: submit, observe the append, and answer health checks as ready.
function createExtensionSim(bridgeRef) {
  return async (message) => {
    const request = /** @type {Record<string, unknown>} */ (message);
    if (request?.kind === 'append_message') {
      await bridgeRef.current.acceptNativeMessage({
        v: 2,
        kind: 'append_progress',
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        status: 'submitted',
        observedRevisions: REVISIONS,
      });
      await bridgeRef.current.acceptNativeMessage({
        v: 2,
        kind: 'append_result',
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        status: 'host_observed',
        hostMessageId: HOST_MESSAGE_ID,
        observedRevisions: REVISIONS,
      });
    }
    if (request?.kind === 'health_check') {
      await bridgeRef.current.acceptNativeMessage({
        v: 2,
        kind: 'health_result',
        requestId: request.requestId,
        status: 'ready',
        observedRevisions: REVISIONS,
      });
    }
  };
}

async function writePairingRecord(dataDirectory, overrides = {}) {
  await mkdir(dataDirectory, { recursive: true });
  const record = {
    schemaVersion: 1,
    extensionId: 'a'.repeat(32),
    socketPath: join(dataDirectory, 'host.sock'),
    ledgerPath: join(dataDirectory, 'ledger.json'),
    pairingSecret: PAIRING_SECRET,
    artifactDigest: helperArtifactRevision,
    installedAt: '2026-08-12T23:00:00.000Z',
    updatedAt: '2026-08-12T23:00:00.000Z',
    ...overrides,
  };
  await writeFile(join(dataDirectory, 'pairing.json'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function writeBinding(paths, conversationId = CONVERSATION_ID) {
  await writeFile(
    paths.conversationBindingPath,
    `${JSON.stringify({
      schemaVersion: 1,
      provider: 'chatgpt',
      conversationId,
      chatUrl: `https://chatgpt.com/c/${conversationId}`,
      boundAt: '2026-08-21T07:00:00.000Z',
      updatedAt: '2026-08-21T07:00:00.000Z',
    })}\n`,
    { mode: 0o600 },
  );
}

async function rmBinding(paths) {
  await rm(paths.conversationBindingPath, { force: true });
}

async function startBridgeEnv(t, label, options = {}) {
  const { sendNative = createExtensionSim, binding = true, conversationId = CONVERSATION_ID } = options;
  const root = await mkdtemp(join(tmpdir(), `f247-p2b-${label}-`));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const paths = {
    socketPath: join(root, 'host.sock'),
    ledgerPath: join(root, 'ledger.json'),
    conversationBindingPath: join(root, 'conversation-binding.json'),
  };
  const dataDirectory = join(root, 'data');
  await writePairingRecord(dataDirectory, {
    socketPath: paths.socketPath,
    ledgerPath: paths.ledgerPath,
  });
  if (binding) await writeBinding(paths, conversationId);
  const bridgeRef = { current: null };
  const bridge = await createNativeHostBridgeImpl({
    ...paths,
    pairingSecret: PAIRING_SECRET,
    helperArtifactRevision,
    sendNative: sendNative(bridgeRef),
  });
  bridgeRef.current = bridge;
  t.after(async () => {
    await bridge.stop();
  });
  const operations = createConversationHostOperations({ dataDirectory, timeoutMs: 5_000 });
  return { root, paths, dataDirectory, bridge, operations, conversationId };
}

const appendInput = (overrides = {}) => ({
  conversationId: CONVERSATION_ID,
  text: 'hello cloud cat',
  idempotencyKey: SOURCE_MESSAGE_ID,
  ...overrides,
});

async function seedAssistantReturn(bridge) {
  await bridge.acceptNativeMessage({
    v: 2,
    kind: 'assistant_final_observed',
    requestId: 'native-return-1',
    conversationId: CONVERSATION_ID,
    idempotencyKey: SOURCE_MESSAGE_ID,
    hostMessageId: HOST_MESSAGE_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    content: 'exact causal assistant final',
    observedRevisions: REVISIONS,
  });
}

test('appendMessage succeeds end to end through the real helper socket and the probe reports ok', async (t) => {
  const { operations } = await startBridgeEnv(t, 'append-success');

  const result = await operations.appendMessage(appendInput());
  assert.deepEqual(result, { status: 'appended', providerMessageId: HOST_MESSAGE_ID, idempotentReplay: false });
  assert.equal(isCloudConversationAppendMessageResult(result), true, 'append result passes the contract validator');

  const probe = await operations.probe();
  assert.equal(probe.ok, true, 'probe reports ok when the helper answers the health check');
});

test('appendMessage reports NEEDS_BINDING when no conversation is authorized', async (t) => {
  const env = await startBridgeEnv(t, 'needs-binding');
  await rmBinding(env.paths);

  const result = await env.operations.appendMessage(appendInput());
  assert.deepEqual(result, { status: 'failed', errorCode: 'NEEDS_BINDING' });
  assert.equal(isCloudConversationAppendMessageResult(result), true, 'NEEDS_BINDING result passes the contract validator');
});

test('appendMessage reports BOUND_CONVERSATION_MISMATCH for an unauthorized conversation', async (t) => {
  const { operations } = await startBridgeEnv(t, 'binding-mismatch');

  const result = await operations.appendMessage(appendInput({ conversationId: 'conversation-8' }));
  assert.deepEqual(result, { status: 'failed', errorCode: 'BOUND_CONVERSATION_MISMATCH' });
  assert.equal(isCloudConversationAppendMessageResult(result), true, 'mismatch result passes the contract validator');
});

test('appendMessage maps a connection refusal to HOST_UNAVAILABLE', async (t) => {
  // Pairing record points at a socket nobody listens on.
  const root = await mkdtemp(join(tmpdir(), 'f247-p2b-refused-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const dataDirectory = join(root, 'data');
  await writePairingRecord(dataDirectory, { socketPath: join(root, 'absent.sock') });
  const operations = createConversationHostOperations({ dataDirectory, timeoutMs: 2_000 });

  const result = await operations.appendMessage(appendInput());
  assert.deepEqual(result, { status: 'failed', errorCode: 'HOST_UNAVAILABLE' });
  assert.equal(isCloudConversationAppendMessageResult(result), true, 'refused result passes the contract validator');
});

test('appendMessage maps a missing pairing record to HOST_UNAVAILABLE', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f247-p2b-no-pairing-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const dataDirectory = join(root, 'data');
  await mkdir(dataDirectory, { recursive: true });
  const operations = createConversationHostOperations({ dataDirectory, timeoutMs: 2_000 });

  const result = await operations.appendMessage(appendInput());
  assert.deepEqual(result, { status: 'failed', errorCode: 'HOST_UNAVAILABLE' });
  assert.equal(isCloudConversationAppendMessageResult(result), true, 'no-pairing result passes the contract validator');
});

test('a socket error after the write maps to AMBIGUOUS_EFFECT, never HOST_UNAVAILABLE', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f247-p2b-closed-after-write-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const socketPath = join(root, 'host.sock');
  // The fake helper dies right after accepting the connection, before answering:
  // the client already wrote the frame (requestSent), so the post-write socket
  // error (EPIPE/ECONNRESET) must surface as AMBIGUOUS_EFFECT, never
  // HOST_UNAVAILABLE and never a bare "unavailable" claim.
  const server = createServer((socket) => {
    socket.on('error', () => {});
    socket.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    server.close();
  });
  const dataDirectory = join(root, 'data');
  await writePairingRecord(dataDirectory, { socketPath });
  const operations = createConversationHostOperations({ dataDirectory, timeoutMs: 2_000 });

  const result = await operations.appendMessage(appendInput());
  assert.deepEqual(result, { status: 'failed', errorCode: 'AMBIGUOUS_EFFECT' });
  assert.equal(isCloudConversationAppendMessageResult(result), true, 'closed-after-write result passes the contract validator');
});

test('a graceful EOF after the write maps to AMBIGUOUS_EFFECT, never INVALID_HOST_RECEIPT', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f247-p2b-eof-after-write-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const socketPath = join(root, 'host.sock');
  // The fake helper accepts the frame and closes the write side without ever
  // sending a receipt: the request was already written, so the effect is
  // unknown and must surface as AMBIGUOUS_EFFECT (ledger h3 (e)).
  const server = createServer((socket) => {
    socket.on('error', () => {});
    socket.on('data', () => {
      socket.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    server.close();
  });
  const dataDirectory = join(root, 'data');
  await writePairingRecord(dataDirectory, { socketPath });
  const operations = createConversationHostOperations({ dataDirectory, timeoutMs: 2_000 });

  const result = await operations.appendMessage(appendInput());
  assert.deepEqual(result, { status: 'failed', errorCode: 'AMBIGUOUS_EFFECT' });
  assert.equal(isCloudConversationAppendMessageResult(result), true, 'eof-after-write result passes the contract validator');
});

test('a truncated receipt followed by EOF maps to AMBIGUOUS_EFFECT, never INVALID_HOST_RECEIPT', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f247-p2b-truncated-receipt-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const socketPath = join(root, 'host.sock');
  // The fake helper answers with a partial JSON line and then closes: no
  // complete receipt ever arrived, so the post-write failure is AMBIGUOUS_EFFECT.
  const server = createServer((socket) => {
    socket.on('error', () => {});
    socket.on('data', () => {
      socket.write('{"partialReceipt":');
      socket.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    server.close();
  });
  const dataDirectory = join(root, 'data');
  await writePairingRecord(dataDirectory, { socketPath });
  const operations = createConversationHostOperations({ dataDirectory, timeoutMs: 2_000 });

  const result = await operations.appendMessage(appendInput());
  assert.deepEqual(result, { status: 'failed', errorCode: 'AMBIGUOUS_EFFECT' });
  assert.equal(isCloudConversationAppendMessageResult(result), true, 'truncated-receipt result passes the contract validator');
});

test('dispose cancels an in-flight append: the peer socket is destroyed and the result is AMBIGUOUS_EFFECT', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f247-p2b-dispose-inflight-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const socketPath = join(root, 'host.sock');
  // The fake helper accepts the frame and then stays silent, holding the
  // request in flight. dispose() must destroy the client socket (the peer
  // sees 'close') and settle the pending append immediately — the frame was
  // already written, so the only truthful code is AMBIGUOUS_EFFECT.
  let serverSocket = null;
  let frameReceived;
  const frameReceivedPromise = new Promise((resolve) => {
    frameReceived = resolve;
  });
  let peerClosedResolve;
  const peerClosed = new Promise((resolve) => {
    peerClosedResolve = resolve;
  });
  const server = createServer((socket) => {
    serverSocket = socket;
    socket.on('error', () => {});
    socket.once('close', () => peerClosedResolve());
    socket.on('data', () => frameReceived());
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    server.close();
  });
  const dataDirectory = join(root, 'data');
  await writePairingRecord(dataDirectory, { socketPath });
  const operations = createConversationHostOperations({ dataDirectory, timeoutMs: 5_000 });

  const started = Date.now();
  const pending = operations.appendMessage(appendInput());
  await frameReceivedPromise;
  assert.ok(serverSocket, 'the helper accepted the connection');

  await operations.dispose();
  const result = await pending;
  assert.deepEqual(result, { status: 'failed', errorCode: 'AMBIGUOUS_EFFECT' });
  assert.equal(isCloudConversationAppendMessageResult(result), true, 'cancelled append passes the contract validator');
  assert.ok(Date.now() - started < 1_000, 'the in-flight append settled promptly instead of waiting for the 5s timeout');
  await Promise.race([
    peerClosed,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('peer socket was not destroyed by dispose')), 1_000)),
  ]);
});

test('a helper timeout after the write maps to AMBIGUOUS_EFFECT and HOST_TIMEOUT never appears', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f247-p2b-timeout-after-write-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const socketPath = join(root, 'host.sock');
  // The fake helper accepts the frame but never answers, forcing the client timeout.
  const server = createServer(() => {});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    server.close();
  });
  const dataDirectory = join(root, 'data');
  await writePairingRecord(dataDirectory, { socketPath });
  const operations = createConversationHostOperations({ dataDirectory, timeoutMs: 200 });

  const result = await operations.appendMessage(appendInput());
  assert.deepEqual(result, { status: 'failed', errorCode: 'AMBIGUOUS_EFFECT' });
  assert.equal(isCloudConversationAppendMessageResult(result), true, 'timeout result passes the contract validator');
});

test('invalid append input fails INVALID_REQUEST without touching the helper', async (t) => {
  const forwarded = [];
  const { operations } = await startBridgeEnv(t, 'invalid-input', {
    sendNative: (bridgeRef) => async (message) => {
      forwarded.push(message);
      await createExtensionSim(bridgeRef)(message);
    },
  });

  for (const input of [
    { conversationId: CONVERSATION_ID, text: '   ', idempotencyKey: SOURCE_MESSAGE_ID },
    { conversationId: CONVERSATION_ID, text: 'hello', idempotencyKey: 'bad token!' },
    {},
  ]) {
    const result = await operations.appendMessage(input);
    assert.deepEqual(result, { status: 'failed', errorCode: 'INVALID_REQUEST' });
    assert.equal(isCloudConversationAppendMessageResult(result), true, 'invalid-input result passes the contract validator');
  }
  assert.deepEqual(forwarded, [], 'invalid input never reached the helper');
});

test('list returns one pending assistant return; ack settles it; un-acked returns stay listed', async (t) => {
  const { operations, bridge } = await startBridgeEnv(t, 'assistant-return');

  const appended = await operations.appendMessage(appendInput());
  assert.equal(appended.status, 'appended');

  // Before any return arrives the inbox is empty.
  assert.deepEqual(await operations.list({}), { returns: [] });

  await seedAssistantReturn(bridge);

  const expected = {
    conversationId: CONVERSATION_ID,
    sourceMessageId: SOURCE_MESSAGE_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    content: 'exact causal assistant final',
  };
  const listed = await operations.list({});
  assert.deepEqual(listed, { returns: [expected] });
  assert.equal(isCloudConversationListResult(listed), true, 'list result passes the contract validator');

  // Listing must never consume: an un-acked return stays in the helper inbox.
  assert.deepEqual(await operations.list({}), { returns: [expected] });

  const acked = await operations.ack({
    conversationId: CONVERSATION_ID,
    sourceMessageId: SOURCE_MESSAGE_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
  });
  assert.deepEqual(acked, { status: 'acknowledged' });
  assert.equal(isCloudConversationAckResult(acked), true, 'ack result passes the contract validator');

  assert.deepEqual(await operations.list({}), { returns: [] });
});

test('ack of an unknown return reports ASSISTANT_RETURN_NOT_FOUND', async (t) => {
  const { operations } = await startBridgeEnv(t, 'ack-unknown');

  const appended = await operations.appendMessage(appendInput());
  assert.equal(appended.status, 'appended');

  const result = await operations.ack({
    conversationId: CONVERSATION_ID,
    sourceMessageId: SOURCE_MESSAGE_ID,
    assistantMessageId: 'conversation-turn-missing',
  });
  assert.deepEqual(result, { status: 'failed', errorCode: 'ASSISTANT_RETURN_NOT_FOUND' });
  assert.equal(isCloudConversationAckResult(result), true, 'unknown-ack result passes the contract validator');
});

test('methods never throw and stay contract-valid after the helper is gone', async (t) => {
  const env = await startBridgeEnv(t, 'helper-gone');
  await env.bridge.stop();

  const appended = await env.operations.appendMessage(appendInput());
  assert.equal(isCloudConversationAppendMessageResult(appended), true, 'append never throws after helper death');
  const listed = await env.operations.list({});
  assert.deepEqual(listed, { returns: [] }, 'list stays empty after helper death');
  const acked = await env.operations.ack({
    conversationId: CONVERSATION_ID,
    sourceMessageId: SOURCE_MESSAGE_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
  });
  assert.equal(isCloudConversationAckResult(acked), true, 'ack never throws after helper death');
});

test('dispose stops the operations and leaves no usable handles', async (t) => {
  const { operations } = await startBridgeEnv(t, 'dispose');

  await operations.dispose();
  assert.deepEqual(await operations.appendMessage(appendInput()), {
    status: 'failed',
    errorCode: 'HOST_UNAVAILABLE',
  });
  assert.deepEqual(await operations.list({}), { returns: [] });
  assert.deepEqual(
    await operations.ack({
      conversationId: CONVERSATION_ID,
      sourceMessageId: SOURCE_MESSAGE_ID,
      assistantMessageId: ASSISTANT_MESSAGE_ID,
    }),
    { status: 'failed', errorCode: 'HOST_UNAVAILABLE' },
  );
  const probe = await operations.probe();
  assert.equal(probe.ok, false);
});

// --- R1 (stop race): dispose during pairing resolution must send nothing ---
async function startCountingServer(t, label) {
  const root = await mkdtemp(join(tmpdir(), `f247-p2b-${label}-`));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const socketPath = join(root, 'host.sock');
  const counts = { connections: 0, frames: 0 };
  const server = createServer((socket) => {
    counts.connections += 1;
    socket.on('error', () => {});
    socket.on('data', () => {
      counts.frames += 1;
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    server.close();
  });
  return { root, socketPath, counts };
}

async function envForCountingServer(t, label, server) {
  const dataDirectory = join(server.root, 'data');
  await writePairingRecord(dataDirectory, { socketPath: server.socketPath });
  return createConversationHostOperations({ dataDirectory, timeoutMs: 2_000 });
}

test('dispose while the pairing record is resolving sends nothing and reports HOST_UNAVAILABLE', async (t) => {
  const server = await startCountingServer(t, 'stop-race-append');
  const operations = await envForCountingServer(t, 'stop-race-append', server);

  // The fs read of the pairing record is still in flight when stop runs:
  // after stop returns no new socket may be created and no frame sent.
  const pending = operations.appendMessage(appendInput());
  await operations.dispose();
  const result = await pending;
  assert.deepEqual(result, { status: 'failed', errorCode: 'HOST_UNAVAILABLE' });
  assert.equal(isCloudConversationAppendMessageResult(result), true, 'stop-race append passes the contract validator');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(server.counts.connections, 0, 'stop during resolution created no socket');
  assert.equal(server.counts.frames, 0, 'stop during resolution sent no frame');
});

test('list and ack racing stop during resolution also send nothing', async (t) => {
  const listServer = await startCountingServer(t, 'stop-race-list');
  const listOps = await envForCountingServer(t, 'stop-race-list', listServer);
  const pendingList = listOps.list({});
  await listOps.dispose();
  assert.deepEqual(await pendingList, { returns: [] });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(listServer.counts.frames, 0, 'list sent no frame after stop');

  const ackServer = await startCountingServer(t, 'stop-race-ack');
  const ackOps = await envForCountingServer(t, 'stop-race-ack', ackServer);
  const pendingAck = ackOps.ack({
    conversationId: CONVERSATION_ID,
    sourceMessageId: SOURCE_MESSAGE_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
  });
  await ackOps.dispose();
  assert.deepEqual(await pendingAck, { status: 'failed', errorCode: 'HOST_UNAVAILABLE' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(ackServer.counts.frames, 0, 'ack sent no frame after stop');
});

test('probe racing stop during resolution reports stopped without connecting', async (t) => {
  const server = await startCountingServer(t, 'stop-race-probe');
  const operations = await envForCountingServer(t, 'stop-race-probe', server);

  const pending = operations.probe();
  await operations.dispose();
  const probe = await pending;
  assert.equal(probe.ok, false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(server.counts.connections, 0, 'probe created no socket after stop');
});

// --- R2 (post-write invalid receipts): the request was written, so the effect
// is unknown and the only truthful code is AMBIGUOUS_EFFECT (ledger h3 (e)) ---
const OVERSIZE_PADDING = 'x'.repeat(256 * 1024);
const INVALID_APPEND_RECEIPTS = [
  { name: 'a complete but empty receipt object', receipt: () => '{}\n' },
  {
    name: 'a receipt with a forged requestId',
    receipt: (request) =>
      `${JSON.stringify({
        v: 2,
        kind: 'append_result',
        requestId: 'forged-request-id',
        idempotencyKey: request.idempotencyKey,
        status: 'host_observed',
        hostMessageId: HOST_MESSAGE_ID,
        observedRevisions: REVISIONS,
      })}\n`,
  },
  {
    name: 'a receipt with a forged idempotencyKey',
    receipt: (request) =>
      `${JSON.stringify({
        v: 2,
        kind: 'append_result',
        requestId: request.requestId,
        idempotencyKey: 'forged-idempotency-key',
        status: 'host_observed',
        hostMessageId: HOST_MESSAGE_ID,
        observedRevisions: REVISIONS,
      })}\n`,
  },
  { name: 'an unparseable receipt line', receipt: () => '{"v":2, broken\n' },
  { name: 'a receipt exceeding the frame limit', receipt: () => `{"v":2,"pad":"${OVERSIZE_PADDING}"}\n` },
];

for (const { name, receipt } of INVALID_APPEND_RECEIPTS) {
  test(`appendMessage maps ${name} after the write to AMBIGUOUS_EFFECT, never INVALID_HOST_RECEIPT`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'f247-p2b-invalid-receipt-'));
    t.after(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const socketPath = join(root, 'host.sock');
    const server = createServer((socket) => {
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        const line = chunk.toString('utf8').trim();
        let request = {};
        try {
          request = JSON.parse(line).request ?? {};
        } catch {}
        socket.write(receipt(request));
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    t.after(async () => {
      server.close();
    });
    const dataDirectory = join(root, 'data');
    await writePairingRecord(dataDirectory, { socketPath });
    const operations = createConversationHostOperations({ dataDirectory, timeoutMs: 2_000 });

    const result = await operations.appendMessage(appendInput());
    assert.deepEqual(result, { status: 'failed', errorCode: 'AMBIGUOUS_EFFECT' });
    assert.equal(
      isCloudConversationAppendMessageResult(result),
      true,
      'invalid-receipt result passes the contract validator',
    );
  });
}

test('a typed failed receipt after the write keeps its own error code', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f247-p2b-typed-failed-receipt-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const socketPath = join(root, 'host.sock');
  const server = createServer((socket) => {
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      const request = JSON.parse(chunk.toString('utf8').trim()).request;
      socket.write(
        `${JSON.stringify({
          v: 2,
          kind: 'append_result',
          requestId: request.requestId,
          idempotencyKey: request.idempotencyKey,
          status: 'failed',
          errorCode: 'NEEDS_BINDING',
        })}\n`,
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    server.close();
  });
  const dataDirectory = join(root, 'data');
  await writePairingRecord(dataDirectory, { socketPath });
  const operations = createConversationHostOperations({ dataDirectory, timeoutMs: 2_000 });

  const result = await operations.appendMessage(appendInput());
  assert.deepEqual(result, { status: 'failed', errorCode: 'NEEDS_BINDING' });
  assert.equal(isCloudConversationAppendMessageResult(result), true, 'typed failed receipt keeps its code');
});

#!/usr/bin/env node

import { timingSafeEqual } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  parsePersonalChromeAppendProgress,
  parsePersonalChromeAppendRequest,
  parsePersonalChromeAppendResult,
  parsePersonalChromeBindingQuery,
  parsePersonalChromeBindingRequest,
} from '../dist/protocol.js';
import {
  PersonalChromeConversationBindingError,
  readPersonalChromeConversationBinding,
  writePersonalChromeConversationBindingAtomic,
} from './conversation-binding.mjs';
import { encodeNativeMessage, NativeMessageDecoder } from './native-framing.mjs';
import { hasCapacityForEntry, ledgerKey, loadLedger, textDigest, writeAtomicLedger } from './native-ledger.mjs';
import { applyTerminalResult, failureFor, safeErrorCode, safeToken, terminalResult } from './native-results.mjs';
import { acquireSocketLease, prepareSocketPath } from './native-socket-lease.mjs';
import { readPersonalChromePairingRecord } from './pairing-record.mjs';

const LOCAL_FRAME_LIMIT = 256 * 1024;
const PROGRESS_ORDER = new Map([
  ['accepted', 0],
  ['extension_received', 1],
  ['inserted', 2],
  ['submitted', 3],
]);

function secretsMatch(expected, received) {
  if (typeof received !== 'string') return false;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(received, 'utf8');
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

function parsePairedAppendEnvelope(expectedPairingSecret, rawEnvelope) {
  const rawRequest = rawEnvelope?.request;
  if (!secretsMatch(expectedPairingSecret, rawEnvelope?.pairingSecret)) {
    return { failure: failureFor(rawRequest, 'PAIRING_REJECTED') };
  }
  try {
    return { request: parsePersonalChromeAppendRequest(rawRequest) };
  } catch {
    return { failure: failureFor(rawRequest, 'INVALID_REQUEST') };
  }
}

function sendSocketResult(socket, result) {
  if (!socket.destroyed) socket.end(`${JSON.stringify(result)}\n`);
}

function respondFromExistingAdmission({ socket, request, digest, existing, pending }) {
  if (existing && existing.textDigest !== digest) {
    sendSocketResult(socket, failureFor(request, 'IDEMPOTENCY_CONFLICT'));
    return true;
  }
  if (pending) {
    pending.responders.push({ socket, requestId: request.requestId });
    return true;
  }
  if (existing?.state === 'host_observed' || existing?.state === 'failed') {
    sendSocketResult(socket, terminalResult(existing, request.requestId));
    return true;
  }
  return false;
}

function validateBridgeOptions(options) {
  if (!options?.socketPath || !options?.ledgerPath || !options?.conversationBindingPath) {
    throw new Error('socketPath, ledgerPath, and conversationBindingPath are required');
  }
  if (typeof options.pairingSecret !== 'string' || !/^[A-Za-z0-9_-]{43,512}$/.test(options.pairingSecret)) {
    throw new Error('pairingSecret must be a Host-issued base64url token');
  }
  if (typeof options.sendNative !== 'function') throw new Error('sendNative is required');
  if (options.writeLedger !== undefined && typeof options.writeLedger !== 'function') {
    throw new Error('writeLedger must be a function');
  }
  if (options.writeConversationBinding !== undefined && typeof options.writeConversationBinding !== 'function') {
    throw new Error('writeConversationBinding must be a function');
  }
}

async function bindingFailureForAppend(path, request) {
  try {
    const binding = await readPersonalChromeConversationBinding(path);
    return binding.conversationId === request.conversationId ? null : 'BOUND_CONVERSATION_MISMATCH';
  } catch (error) {
    return error instanceof PersonalChromeConversationBindingError && error.code === 'NEEDS_BINDING'
      ? 'NEEDS_BINDING'
      : 'BINDING_RECORD_INVALID';
  }
}

async function bindingRecordForRequest(path, request, timestamp, writeBinding) {
  let previous;
  try {
    previous = await readPersonalChromeConversationBinding(path);
  } catch {
    // An explicit extension action may recover a missing or malformed record.
  }
  return writeBinding(path, {
    schemaVersion: 1,
    provider: 'chatgpt',
    conversationId: request.conversationId,
    chatUrl: request.chatUrl,
    boundAt: previous?.conversationId === request.conversationId ? previous.boundAt : timestamp,
    updatedAt: timestamp,
  });
}

async function bindingStatusForQuery(path, requestId) {
  try {
    const record = await readPersonalChromeConversationBinding(path);
    return {
      v: 1,
      kind: 'binding_status',
      requestId,
      status: 'bound',
      conversationId: record.conversationId,
      boundAt: record.boundAt,
    };
  } catch (error) {
    const needsBinding = error instanceof PersonalChromeConversationBindingError && error.code === 'NEEDS_BINDING';
    return {
      v: 1,
      kind: 'binding_status',
      requestId,
      status: needsBinding ? 'unbound' : 'failed',
      errorCode: needsBinding ? 'NEEDS_BINDING' : 'BINDING_RECORD_INVALID',
    };
  }
}

/**
 * Runs the local companion bridge. Paths, secret, and lifecycle are supplied by
 * the installing Host; this module does not install a manifest or launcher.
 */
export async function createNativeHostBridge(options) {
  validateBridgeOptions(options);
  const writeLedger = options.writeLedger ?? writeAtomicLedger;
  const writeConversationBinding = options.writeConversationBinding ?? writePersonalChromeConversationBindingAtomic;
  const now = options.now ?? (() => new Date());

  const ledger = await loadLedger(options.ledgerPath);
  let ledgerDirty = false;
  for (const entry of ledger.values()) {
    if (entry.state !== 'host_observed' && entry.state !== 'failed') {
      entry.state = 'failed';
      entry.errorCode = 'AMBIGUOUS_EFFECT';
      ledgerDirty = true;
    }
  }
  if (ledgerDirty) await writeLedger(options.ledgerPath, ledger);

  await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
  const socketLease = await acquireSocketLease(options.socketPath);
  try {
    await prepareSocketPath(options.socketPath);
  } catch (error) {
    await socketLease.release();
    throw error;
  }

  const pendingByKey = new Map();
  const keyByRequestId = new Map();
  const openSockets = new Set();
  const dispatchWaiters = [];
  let dispatchCount = 0;
  let stopped = false;
  let persistenceQueue = Promise.resolve();

  const persist = () => {
    const snapshot = new Map([...ledger].map(([key, value]) => [key, { ...value }]));
    const write = persistenceQueue.then(() => writeLedger(options.ledgerPath, snapshot));
    persistenceQueue = write.catch(() => undefined);
    return write;
  };

  function announceDispatch() {
    dispatchCount += 1;
    for (let index = dispatchWaiters.length - 1; index >= 0; index -= 1) {
      if (dispatchCount >= dispatchWaiters[index].count) dispatchWaiters.splice(index, 1)[0].resolve();
    }
  }

  async function settle(key, result) {
    const pending = pendingByKey.get(key);
    if (!pending) return;
    const entry = ledger.get(key);
    if (!entry) return;
    applyTerminalResult(entry, result);
    await persist();
    pendingByKey.delete(key);
    keyByRequestId.delete(pending.canonicalRequestId);
    for (const responder of pending.responders) {
      sendSocketResult(responder.socket, terminalResult(entry, responder.requestId));
    }
  }

  async function handleEnvelope(socket, rawEnvelope) {
    const parsed = parsePairedAppendEnvelope(options.pairingSecret, rawEnvelope);
    if (parsed.failure) {
      sendSocketResult(socket, parsed.failure);
      return;
    }
    const request = parsed.request;
    const bindingFailure = await bindingFailureForAppend(options.conversationBindingPath, request);
    if (bindingFailure) {
      sendSocketResult(socket, failureFor(request, bindingFailure));
      return;
    }
    const key = ledgerKey(request.conversationId, request.idempotencyKey);
    const digest = textDigest(request.text);
    const existing = ledger.get(key);
    const pending = pendingByKey.get(key);
    if (respondFromExistingAdmission({ socket, request, digest, existing, pending })) return;
    const acceptedEntry = {
      conversationId: request.conversationId,
      idempotencyKey: request.idempotencyKey,
      textDigest: digest,
      state: 'accepted',
    };
    if (!existing && !hasCapacityForEntry(ledger, acceptedEntry)) {
      sendSocketResult(socket, failureFor(request, 'LEDGER_CAPACITY_EXCEEDED'));
      return;
    }
    ledger.set(key, acceptedEntry);
    pendingByKey.set(key, {
      canonicalRequestId: request.requestId,
      responders: [{ socket, requestId: request.requestId }],
    });
    keyByRequestId.set(request.requestId, key);
    try {
      await persist();
      await options.sendNative(request);
      announceDispatch();
    } catch {
      await settle(key, failureFor(request, 'NATIVE_DISPATCH_FAILED'));
    }
  }

  const server = createServer((socket) => {
    openSockets.add(socket);
    let input = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.on('close', () => openSockets.delete(socket));
    socket.on('data', (chunk) => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > LOCAL_FRAME_LIMIT) {
        handled = true;
        sendSocketResult(socket, failureFor(undefined, 'LOCAL_FRAME_TOO_LARGE'));
        return;
      }
      const newline = input.indexOf('\n');
      if (newline === -1) return;
      handled = true;
      let envelope;
      try {
        envelope = JSON.parse(input.slice(0, newline));
      } catch {
        sendSocketResult(socket, failureFor(undefined, 'INVALID_LOCAL_FRAME'));
        return;
      }
      void handleEnvelope(socket, envelope).catch(() => {
        sendSocketResult(socket, failureFor(envelope?.request, 'HELPER_INTERNAL_ERROR'));
      });
    });
  });
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(options.socketPath, resolveListen);
    });
    await chmod(options.socketPath, 0o600);
  } catch (error) {
    if (server.listening) {
      await new Promise((resolveClose, rejectClose) =>
        server.close((closeError) => (closeError ? rejectClose(closeError) : resolveClose())),
      );
    }
    await socketLease.release();
    throw error;
  }

  async function acceptProgress(message) {
    if (message?.kind !== 'append_progress') return false;
    let progress;
    try {
      progress = parsePersonalChromeAppendProgress(message);
    } catch {
      return true;
    }
    const key = keyByRequestId.get(progress.requestId);
    const entry = key ? ledger.get(key) : undefined;
    const currentOrder = entry ? PROGRESS_ORDER.get(entry.state) : undefined;
    const nextOrder = PROGRESS_ORDER.get(progress.status);
    if (
      entry &&
      progress.idempotencyKey === entry.idempotencyKey &&
      nextOrder !== undefined &&
      currentOrder !== undefined &&
      nextOrder >= currentOrder
    ) {
      entry.state = progress.status;
      await persist();
    }
    return true;
  }

  async function acceptTerminalResult(message) {
    if (message?.kind !== 'append_result') return;
    let result;
    try {
      result = parsePersonalChromeAppendResult(message);
    } catch {
      return;
    }
    const key = keyByRequestId.get(result.requestId);
    if (!key) return;
    const entry = ledger.get(key);
    if (!entry || result.idempotencyKey !== entry.idempotencyKey) {
      await settle(key, failureFor(result, 'INVALID_HOST_RECEIPT'));
      return;
    }
    if (result.status === 'host_observed') {
      await settle(key, result);
      return;
    }
    await settle(key, failureFor(result, safeErrorCode(result.errorCode) ? result.errorCode : 'NATIVE_DELIVERY_FAILED'));
  }

  async function acceptBindingRequest(message) {
    if (message?.kind !== 'bind_conversation') return false;
    let request;
    try {
      request = parsePersonalChromeBindingRequest(message);
    } catch {
      await options.sendNative({
        v: 1,
        kind: 'binding_result',
        requestId: safeToken(message?.requestId, 200) ? message.requestId : 'invalid-request',
        status: 'failed',
        errorCode: 'INVALID_BINDING_REQUEST',
      });
      return true;
    }
    const timestamp = now().toISOString();
    let record;
    try {
      record = await bindingRecordForRequest(options.conversationBindingPath, request, timestamp, writeConversationBinding);
    } catch {
      await options.sendNative({
        v: 1,
        kind: 'binding_result',
        requestId: request.requestId,
        status: 'failed',
        errorCode: 'BINDING_WRITE_FAILED',
      });
      return true;
    }
    await options.sendNative({
      v: 1,
      kind: 'binding_result',
      requestId: request.requestId,
      status: 'bound',
      conversationId: record.conversationId,
      boundAt: record.boundAt,
    });
    return true;
  }

  async function acceptBindingQuery(message) {
    if (message?.kind !== 'query_binding') return false;
    let request;
    try {
      request = parsePersonalChromeBindingQuery(message);
    } catch {
      await options.sendNative({
        v: 1,
        kind: 'binding_status',
        requestId: safeToken(message?.requestId, 200) ? message.requestId : 'invalid-request',
        status: 'failed',
        errorCode: 'INVALID_BINDING_QUERY',
      });
      return true;
    }
    await options.sendNative(await bindingStatusForQuery(options.conversationBindingPath, request.requestId));
    return true;
  }

  return {
    socketPath: options.socketPath,
    ledgerPath: options.ledgerPath,
    async acceptNativeMessage(message) {
      if (await acceptBindingRequest(message)) return;
      if (await acceptBindingQuery(message)) return;
      if (await acceptProgress(message)) return;
      await acceptTerminalResult(message);
    },
    waitForDispatchCount(count) {
      if (dispatchCount >= count) return Promise.resolve();
      return new Promise((resolveWaiter) => dispatchWaiters.push({ count, resolve: resolveWaiter }));
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        for (const [key, pending] of pendingByKey) {
          const entry = ledger.get(key);
          for (const responder of pending.responders) {
            sendSocketResult(
              responder.socket,
              failureFor({ requestId: responder.requestId, idempotencyKey: entry?.idempotencyKey }, 'HOST_STOPPED'),
            );
          }
        }
        for (const socket of openSockets) socket.destroy();
        await new Promise((resolveClose, rejectClose) => server.close((error) => (error ? rejectClose(error) : resolveClose())));
        await persistenceQueue;
      } finally {
        await socketLease.release();
      }
    },
  };
}

function pairingRecordArgument(argv) {
  const index = argv.indexOf('--pairing-record');
  return index === -1 ? undefined : argv[index + 1];
}

function requireAbsoluteHostPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || !isAbsolute(value)) {
    throw new Error(`${label} must be absolute`);
  }
  return value;
}

export function assertSupportedPlatform(platform = process.platform) {
  if (platform === 'win32') throw new Error('Windows is unsupported for the Personal Chrome Native Messaging helper');
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(`unsupported platform for the Personal Chrome Native Messaging helper: ${platform}`);
  }
}

export async function resolveNativeHostConfiguration({
  pairingRecordPath,
  env = process.env,
  argv = process.argv.slice(2),
  platform = process.platform,
} = {}) {
  assertSupportedPlatform(platform);
  const explicitRecordPath = pairingRecordPath ?? pairingRecordArgument(argv);
  if (explicitRecordPath) {
    const record = await readPersonalChromePairingRecord(explicitRecordPath);
    return {
      socketPath: record.socketPath,
      ledgerPath: record.ledgerPath,
      conversationBindingPath: resolve(dirname(record.ledgerPath), 'conversation-binding.json'),
      pairingSecret: record.pairingSecret,
    };
  }
  const socketPath = env.CAT_CAFE_PERSONAL_CHROME_SOCKET;
  const ledgerPath = env.CAT_CAFE_PERSONAL_CHROME_LEDGER;
  const pairingSecret = env.CAT_CAFE_PERSONAL_CHROME_PAIRING_SECRET;
  if (!socketPath || !ledgerPath || !pairingSecret) {
    throw new Error('required personal Chrome host configuration is missing');
  }
  const canonicalSocketPath = requireAbsoluteHostPath(socketPath, 'socketPath');
  const canonicalLedgerPath = requireAbsoluteHostPath(ledgerPath, 'ledgerPath');
  return {
    socketPath: canonicalSocketPath,
    ledgerPath: canonicalLedgerPath,
    conversationBindingPath: resolve(dirname(canonicalLedgerPath), 'conversation-binding.json'),
    pairingSecret,
  };
}

export async function runNativeHost(options = {}) {
  const { socketPath, ledgerPath, conversationBindingPath, pairingSecret } = await resolveNativeHostConfiguration(options);
  const decoder = new NativeMessageDecoder();
  const bridge = await createNativeHostBridge({
    socketPath,
    ledgerPath,
    conversationBindingPath,
    pairingSecret,
    sendNative: (message) => process.stdout.write(encodeNativeMessage(message)),
  });
  let bridgeStop;
  const stopBridge = () => {
    bridgeStop ??= bridge.stop();
    return bridgeStop;
  };
  const reportFailure = (error) => {
    process.exitCode = 1;
    process.stderr.write(`personal Chrome native host failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
  };
  const stopAfterInputFailure = (error) => {
    reportFailure(error);
    process.stdin.destroy();
    void stopBridge().catch(reportFailure);
  };
  process.stdin.on('data', (chunk) => {
    try {
      for (const message of decoder.push(chunk)) void bridge.acceptNativeMessage(message).catch(stopAfterInputFailure);
    } catch (error) {
      stopAfterInputFailure(error);
    }
  });
  process.stdin.once('end', () => {
    try {
      decoder.finish();
    } catch (error) {
      stopAfterInputFailure(error);
      return;
    }
    void stopBridge().catch(reportFailure);
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  runNativeHost({ argv: process.argv.slice(2) }).catch((error) => {
    process.stderr.write(`personal Chrome native host failed: ${error instanceof Error ? error.message : 'unknown'}\n`);
    process.exitCode = 1;
  });
}

import { timingSafeEqual } from 'node:crypto';
import { chmod, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import {
  encodeNativeMessage,
  NativeMessageDecoder,
} from '../../cloud-cat-personal-host/native-host/native-framing.mjs';
import {
  acquireSocketLease,
  prepareSocketPath,
} from '../../cloud-cat-personal-host/native-host/native-socket-lease.mjs';
import { readPersonalChromePairingRecord } from '../../cloud-cat-personal-host/native-host/pairing-record.mjs';
import { VERSION } from './contract.mjs';
export function secretMatches(expected, received) {
  if (typeof received !== 'string') return false;
  const left = Buffer.from(expected),
    right = Buffer.from(received);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function startNativeHost(recordPath, { input = process.stdin, output = process.stdout } = {}) {
  const record = await readPersonalChromePairingRecord(recordPath);
  const lease = await acquireSocketLease(record.socketPath);
  const pending = new Map();
  const connections = new Set();
  const decoder = new NativeMessageDecoder();
  let closed = false;
  let listening = false;
  const server = createServer((socket) => {
    if (connections.size >= 8) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    const incoming = new NativeMessageDecoder();
    let used = false;
    socket.setTimeout(25000, () => socket.destroy());
    socket.on('close', () => {
      connections.delete(socket);
      for (const [id, item] of pending)
        if (item.socket === socket) {
          clearTimeout(item.timer);
          pending.delete(id);
        }
    });
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk) => {
      try {
        for (const request of incoming.push(chunk)) {
          if (
            used ||
            request.v !== 1 ||
            typeof request.id !== 'string' ||
            !/^[a-f0-9-]{36}$/.test(request.id) ||
            !secretMatches(record.pairingSecret, request.token) ||
            !['status', 'observe'].includes(request.op) ||
            Object.keys(request).some((key) => !['v', 'id', 'op', 'token'].includes(key))
          )
            throw new Error('UNAUTHORIZED');
          used = true;
          if (pending.has(request.id)) throw new Error('DUPLICATE_REQUEST');
          const timer = setTimeout(() => {
            pending.delete(request.id);
            socket.end(encodeNativeMessage({ v: 1, id: request.id, error: 'EXTENSION_TIMEOUT' }));
          }, 22000);
          pending.set(request.id, { socket, timer });
          output.write(encodeNativeMessage({ v: 1, id: request.id, op: request.op }));
        }
      } catch {
        socket.destroy();
      }
    });
  });
  async function close() {
    if (closed) return;
    closed = true;
    for (const item of pending.values()) clearTimeout(item.timer);
    pending.clear();
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    if (listening) await unlink(record.socketPath).catch(() => undefined);
    await lease.release();
  }
  try {
    await prepareSocketPath(record.socketPath);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(record.socketPath, resolve);
    });
    listening = true;
    await chmod(record.socketPath, 0o600);
    input.on('data', (chunk) => {
      try {
        for (const message of decoder.push(chunk)) {
          const item = pending.get(message.id);
          if (message.v !== 1 || !item) continue;
          pending.delete(message.id);
          clearTimeout(item.timer);
          item.socket.end(encodeNativeMessage(message));
        }
      } catch {
        void close();
      }
    });
    input.once('end', () => void close());
    output.write(encodeNativeMessage({ v: 1, kind: 'ready', version: VERSION }));
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}
if (process.argv[2] === '--pairing-record') {
  startNativeHost(process.argv[3]).catch(() => {
    process.stderr.write('TRIPO_NATIVE_HOST_FAILED\n');
    process.exitCode = 1;
  });
}

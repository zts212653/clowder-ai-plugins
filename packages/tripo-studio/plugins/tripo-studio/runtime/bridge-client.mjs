import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import {
  encodeNativeMessage,
  NativeMessageDecoder,
} from '../../cloud-cat-personal-host/native-host/native-framing.mjs';
import { readPersonalChromePairingRecord } from '../../cloud-cat-personal-host/native-host/pairing-record.mjs';
import { validateWorkspaceRequest } from './workspace-contract.mjs';
import { VERSION } from './contract.mjs';
import { pluginPaths } from './paths.mjs';
export async function callBridge(
  op,
  { paths = pluginPaths(), timeoutMs = 20000, signal, payload } = {},
) {
  signal?.throwIfAborted();
  if (!['status', 'observe', 'workspace'].includes(op))
    throw new Error('INVALID_OPERATION');
  if (op === 'workspace') validateWorkspaceRequest(payload);
  let record;
  try {
    record = await readPersonalChromePairingRecord(paths.record);
  } catch {
    throw new Error('HELPER_NOT_INSTALLED: 请在 Tripo 插件中准备本机组件。');
  }
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = connect(record.socketPath);
    const decoder = new NativeMessageDecoder();
    let settled = false;
    const abort = () => finish(signal.reason);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (
        (!error && result?.version !== VERSION) ||
        error?.message === 'HELPER_VERSION_MISMATCH'
      ) {
        error = Object.assign(
          new Error(
            'CHROME_VERSION_MISMATCH: 请通过 Tripo 插件修复本机组件，再在 Chrome 加载返回的新扩展目录并重新授权。',
          ),
          {
            code: 'CHROME_VERSION_MISMATCH',
            observedVersion:
              typeof result?.version === 'string'
                ? result.version.slice(0, 64)
                : null,
          },
        );
      }
      error ? reject(error) : resolve(result);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    socket.setTimeout(timeoutMs, () =>
      finish(new Error('HELPER_TIMEOUT: 请在 Tripo 扩展中刷新状态。')),
    );
    socket.on('connect', () => {
      try {
        socket.write(
          encodeNativeMessage({
            v: 1,
            id,
            op,
            ...(op === 'workspace' ? { payload } : {}),
            token: record.pairingSecret,
          }),
        );
      } catch (error) {
        finish(error);
      }
    });
    socket.on('error', () =>
      finish(new Error('HELPER_DISCONNECTED: 请加载 Tripo 扩展并刷新状态。')),
    );
    socket.on('data', (chunk) => {
      try {
        for (const message of decoder.push(chunk)) {
          if (message.v !== 1 || message.id !== id)
            throw new Error('MISMATCHED_RESPONSE');
          finish(
            message.error ? new Error(message.error) : undefined,
            message.result,
          );
        }
      } catch (error) {
        finish(error);
      }
    });
    socket.on('end', () => finish(new Error('HELPER_DISCONNECTED')));
  });
}

import { homedir } from 'node:os';
import { join } from 'node:path';
import { callBridge } from './bridge-client.mjs';
import { VERSION } from './contract.mjs';

export const defaultRoot = join(homedir(), 'Downloads/Tripo');

export async function readStatus({ signal } = {}) {
  try {
    const bridge = await callBridge('status', { signal });
    return {
      artifact: { version: VERSION },
      config: { defaultOutputDirectory: defaultRoot, directorySource: 'per_call' },
      auth: { status: bridge.authorized?.length ? 'authorized' : 'disconnected', pages: bridge.authorized ?? [] },
      live: { status: 'connected', observedVersion: bridge.version },
      sharedLinks: { requiresLogin: false },
    };
  } catch (error) {
    signal?.throwIfAborted();
    const mismatch = error.code === 'CHROME_VERSION_MISMATCH';
    return {
      artifact: { version: VERSION },
      config: { defaultOutputDirectory: defaultRoot, directorySource: 'per_call' },
      auth: { status: 'unverified' },
      live: {
        status: mismatch ? 'error' : 'dormant',
        reason: error.message,
        ...(mismatch ? { observedVersion: error.observedVersion } : {}),
      },
      sharedLinks: { requiresLogin: false },
      nextAction: mismatch ? error.message : '分享链接可直接审模；已登录页面通道需要准备本机组件，并在 Chrome 授权。',
    };
  }
}

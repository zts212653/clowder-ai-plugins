import type { HostBridgeTransport } from './host-bridge.js';

interface BridgeConnectMessage {
  v: 1;
  kind: 'cat-cafe-content-editor-connect';
  bridgeVersion: '1.0.0';
  sessionToken: string;
  handshakeNonce: string;
}

interface BridgeResponseMessage {
  v: 1;
  kind: 'cat-cafe-content-editor-response';
  sessionToken: string;
  requestId: string;
  ok: boolean;
  value?: unknown;
  error?: { code?: string; message?: string };
}

export interface RendererBootstrapV1 {
  readonly parentOrigin: string;
  readonly handshakeNonce: string;
}

export function parseRendererBootstrap(target: Window): RendererBootstrapV1 {
  const params = new URLSearchParams(target.location.hash.slice(1));
  const parentOrigin = params.get('cat-cafe-parent-origin');
  const handshakeNonce = params.get('cat-cafe-handshake');
  if (!parentOrigin || !handshakeNonce || !/^handshake_[A-Za-z0-9_-]{32,128}$/.test(handshakeNonce)) {
    throw new Error('renderer bootstrap is missing its parent origin or handshake nonce');
  }
  const parsed = new URL(parentOrigin);
  if (parsed.origin !== parentOrigin || !isAllowedParentOrigin(parsed)) {
    throw new Error('renderer bootstrap parent origin is invalid');
  }
  return { parentOrigin, handshakeNonce };
}

export function createMessagePortTransport(
  target: Window,
  bootstrap: RendererBootstrapV1,
): HostBridgeTransport {
  return new MessagePortTransport(target, bootstrap);
}

function isConnectMessage(value: unknown, handshakeNonce: string): value is BridgeConnectMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    record.kind === 'cat-cafe-content-editor-connect' &&
    record.bridgeVersion === '1.0.0' &&
    typeof record.sessionToken === 'string' &&
    record.sessionToken.length >= 32 &&
    record.handshakeNonce === handshakeNonce
  );
}

function isAllowedParentOrigin(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]' ||
      url.hostname.endsWith('.localhost'))
  );
}

class MessagePortTransport implements HostBridgeTransport {
  readonly #connected: Promise<void>;
  readonly #pending = new Map<
    string,
    { resolve(value: unknown): void; reject(reason: Error): void }
  >();
  #port: MessagePort | null = null;
  #sessionToken: string | null = null;
  #sequence = 0;

  constructor(target: Window, bootstrap: RendererBootstrapV1) {
    this.#connected = new Promise((resolve) => {
      const receiveConnect = (event: MessageEvent<unknown>): void => {
        if (
          event.source !== target.parent ||
          event.origin !== bootstrap.parentOrigin ||
          event.ports.length !== 1 ||
          !isConnectMessage(event.data, bootstrap.handshakeNonce)
        ) {
          return;
        }
        target.removeEventListener('message', receiveConnect);
        this.#port = event.ports[0] ?? null;
        this.#sessionToken = event.data.sessionToken;
        if (this.#port === null) return;
        this.#port.addEventListener('message', (message) => this.#receive(message));
        this.#port.start();
        resolve();
      };
      target.addEventListener('message', receiveConnect);
    });
  }

  async request(operation: Parameters<HostBridgeTransport['request']>[0], payload: unknown): Promise<unknown> {
    await this.#connected;
    if (this.#port === null || this.#sessionToken === null) throw new Error('bridge is not connected');
    const requestId = `renderer-${++this.#sequence}`;
    const result = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
    });
    this.#port.postMessage({
      v: 1,
      kind: 'cat-cafe-content-editor-request',
      sessionToken: this.#sessionToken,
      requestId,
      operation,
      payload,
    });
    return result;
  }

  #receive(event: MessageEvent<unknown>): void {
    if (typeof event.data !== 'object' || event.data === null || Array.isArray(event.data)) return;
    const record = event.data as Record<string, unknown>;
    if (
      record.v !== 1 ||
      record.kind !== 'cat-cafe-content-editor-response' ||
      record.sessionToken !== this.#sessionToken ||
      typeof record.requestId !== 'string' ||
      typeof record.ok !== 'boolean'
    ) {
      return;
    }
    const response = record as unknown as BridgeResponseMessage;
    const pending = this.#pending.get(response.requestId);
    if (pending === undefined) return;
    this.#pending.delete(response.requestId);
    if (response.ok) pending.resolve(response.value);
    else {
      const error = new Error(response.error?.message ?? 'Host bridge request failed') as Error & {
        code?: string;
      };
      if (response.error?.code !== undefined) error.code = response.error.code;
      pending.reject(error);
    }
  }
}

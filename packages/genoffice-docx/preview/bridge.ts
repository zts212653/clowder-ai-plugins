/**
 * Browser half of the read-only preview protocol.
 *
 * Order is part of the contract: navigation denial is installed before any other
 * work, then ready is posted, then exactly one snapshot is accepted over the
 * transferred port. The port never services renderer requests.
 */
import {
  isConnectMessage,
  isSnapshotMessage,
  PREVIEW_MEDIA_TYPES,
  readBootstrap,
  type PreviewBootstrap,
  type PreviewSnapshot,
} from '../src/preview-protocol';

export class PreviewBridgeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PreviewBridgeError';
  }
}

export interface PreviewBridgeOptions {
  readonly onSnapshot: (snapshot: PreviewSnapshot) => void;
  readonly onError: (error: PreviewBridgeError) => void;
  readonly connectTimeoutMs?: number;
}

export function installNavigationDeny(target: Window): void {
  const navigation = Reflect.get(target, 'navigation') as
    | { addEventListener?: (type: string, listener: (event: Event) => void) => void }
    | undefined;
  if (!navigation || typeof navigation.addEventListener !== 'function') {
    throw new PreviewBridgeError('navigation_api_unavailable');
  }
  navigation.addEventListener('navigate', (event) => event.preventDefault());
}

export function startPreviewBridge(options: PreviewBridgeOptions): () => void {
  let bootstrap: PreviewBootstrap;
  try {
    bootstrap = readBootstrap(window.location.hash, window.location.origin);
    installNavigationDeny(window);
  } catch (error) {
    options.onError(
      error instanceof PreviewBridgeError ? error : new PreviewBridgeError(String(error)),
    );
    return () => undefined;
  }

  const allowed = new Set<string>(Object.values(PREVIEW_MEDIA_TYPES));
  let connected = false;
  let delivered = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const fail = (code: string) => {
    if (timer) clearTimeout(timer);
    timer = null;
    window.removeEventListener('message', onMessage);
    options.onError(new PreviewBridgeError(code));
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== bootstrap.parentOrigin) return;
    if (!isConnectMessage(event.data, bootstrap.handshakeNonce)) return;
    if (connected) return;
    const port = event.ports[0];
    if (!port || event.ports.length !== 1) {
      fail('preview_port_missing');
      return;
    }
    connected = true;
    window.removeEventListener('message', onMessage);
    if (timer) clearTimeout(timer);
    timer = null;
    port.onmessage = (message: MessageEvent) => {
      if (delivered) return;
      if (!isSnapshotMessage(message.data, allowed)) {
        port.close();
        fail('preview_snapshot_invalid');
        return;
      }
      delivered = true;
      port.close();
      options.onSnapshot(message.data);
    };
    port.start?.();
  };

  window.addEventListener('message', onMessage);
  window.parent.postMessage(
    { v: 1, kind: 'cat-cafe-content-preview-ready', handshakeNonce: bootstrap.handshakeNonce },
    bootstrap.parentOrigin,
  );

  timer = setTimeout(() => {
    if (!connected) fail('preview_connect_timeout');
  }, options.connectTimeoutMs ?? 15_000);

  return () => {
    if (timer) clearTimeout(timer);
    window.removeEventListener('message', onMessage);
  };
}

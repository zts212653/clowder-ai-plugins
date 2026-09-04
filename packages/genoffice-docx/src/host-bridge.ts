export type HostBridgeOperation =
  | 'content.load'
  | 'content.settle'
  | 'surface.fontMetric';

export interface HostBridgeTransport {
  request(operation: HostBridgeOperation, payload: unknown): Promise<unknown>;
}

export interface BridgePresentation {
  operationId(): string;
  language: 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'es' | 'th' | 'id' | 'ru' | 'ar';
  theme: 'light' | 'dark' | 'system';
}

interface LoadedContent {
  contentIdentity: string;
  fileName: string;
  ownerRevision: number;
  blobDigest: `sha256:${string}`;
  bytes: ArrayBuffer;
}

interface SettlementReceipt {
  receiptId: string;
  ownerRevision: number;
  blobDigest: `sha256:${string}`;
}

interface RemoteBridgeError extends Error {
  code?: string;
}

export class BridgeDeniedError extends Error {
  readonly code = 'bridge_method_denied';

  constructor(method: string) {
    super(`GenOffice bridge method is denied by Host policy: ${method}`);
    this.name = 'BridgeDeniedError';
  }
}

export function installNetworkDeny(target: object): void {
  const blockedAsync = async (): Promise<never> => {
    throw new BridgeDeniedError('fetch');
  };
  class BlockedXmlHttpRequest {
    constructor() {
      throw new BridgeDeniedError('XMLHttpRequest');
    }
  }
  class BlockedWebSocket {
    constructor() {
      throw new BridgeDeniedError('WebSocket');
    }
  }
  class BlockedEventSource {
    constructor() {
      throw new BridgeDeniedError('EventSource');
    }
  }
  for (const [name, value] of Object.entries({
    fetch: blockedAsync,
    XMLHttpRequest: BlockedXmlHttpRequest,
    WebSocket: BlockedWebSocket,
    EventSource: BlockedEventSource,
  })) {
    Object.defineProperty(target, name, {
      value,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
  const navigatorValue = Reflect.get(target, 'navigator');
  if (typeof navigatorValue === 'object' && navigatorValue !== null) {
    Object.defineProperty(navigatorValue, 'sendBeacon', {
      value: () => {
        throw new BridgeDeniedError('sendBeacon');
      },
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
}

export interface GenOfficeDesktopBridge extends Record<string, unknown> {
  getLanguage(): Promise<BridgePresentation['language']>;
  getTheme(): Promise<BridgePresentation['theme']>;
  onLanguageChanged(handler: (language: BridgePresentation['language']) => void): () => void;
  onThemeChanged(handler: (theme: BridgePresentation['theme']) => void): () => void;
  onChromePressed(handler: () => void): () => void;
  consumePendingOpenDocx(): Promise<{
    path: string;
    name: string;
    data: ArrayBuffer;
    hash: string;
  }>;
  saveDocx(
    path: string,
    data: ArrayBuffer,
    auto?: boolean,
  ): Promise<{ ok: true } | { ok: false; reason: 'external-modified' }>;
  getRecentFiles(): Promise<string[]>;
  getAiSettings(): Promise<{
    provider: 'custom';
    providers: Record<string, never>;
    gskToolsEnabled: false;
  }>;
  consumeNewBlankDoc(): Promise<false>;
  consumeAiDocContent(): Promise<null>;
  docPasswordIntentRevision(): Promise<0>;
  fontMetrics(family: string): Promise<unknown>;
  onOpenDocx(handler: (value: unknown) => void): () => void;
  onRenamedDocx(handler: (value: unknown) => void): () => void;
  onTeardown(handler: () => void): () => void;
  onAiStream(handler: (value: unknown) => void): () => void;
  onMenuCommand(handler: (value: unknown) => void): () => void;
  onCloseCheck(handler: () => void): () => void;
  onCloseSaveRequest(handler: () => void): () => void;
  reportViewMenuState(value: unknown): void;
  reportCloseCheck(value: unknown): void;
  reportCloseSaveResult(value: unknown): void;
  openDocx(...args: unknown[]): Promise<never>;
  aiGskLogin(...args: unknown[]): Promise<never>;
  webSearch(...args: unknown[]): Promise<never>;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`invalid ${label} response`);
  }
  return value as Record<string, unknown>;
}

function requireLoadedContent(value: unknown): LoadedContent {
  const record = requireObject(value, 'content.load');
  if (
    typeof record.contentIdentity !== 'string' ||
    typeof record.fileName !== 'string' ||
    !Number.isSafeInteger(record.ownerRevision) ||
    typeof record.blobDigest !== 'string' ||
    !record.blobDigest.startsWith('sha256:') ||
    !(record.bytes instanceof ArrayBuffer)
  ) {
    throw new Error('invalid content.load response');
  }
  return record as unknown as LoadedContent;
}

function requireReceipt(value: unknown): SettlementReceipt {
  const record = requireObject(value, 'content.settle');
  if (
    typeof record.receiptId !== 'string' ||
    !Number.isSafeInteger(record.ownerRevision) ||
    typeof record.blobDigest !== 'string' ||
    !record.blobDigest.startsWith('sha256:')
  ) {
    throw new Error('invalid content.settle response');
  }
  return record as unknown as SettlementReceipt;
}

const DENIED_ASYNC_METHODS = [
  'openDocx',
  'openDocxPath',
  'openDocxDecrypt',
  'setDocPassword',
  'discardDocPasswordIntents',
  'createDocument',
  'writeRecoveryCopy',
  'saveDocxAs',
  'saveDocxNew',
  'pickImage',
  'print',
  'exportPdf',
  'printPdfBuffer',
  'saveMergedPdf',
  'setAiSettings',
  'aiChat',
  'aiStream',
  'aiStreamCancel',
  'aiGskStatus',
  'aiGskLogin',
  'webSearch',
  'imageSearch',
  'fetchImage',
  'aiGenerateImage',
  'pickAttachments',
  'addAttachmentPaths',
  'addPastedImage',
  'copyImageToClipboard',
  'readAttachment',
  'readAttachmentImage',
  'openNewTab',
  'listDocsTabs',
  'focusDocsTab',
] as const;

const noopSubscription = (): (() => void) => () => undefined;

export function createGenOfficeDesktopBridge(
  transport: HostBridgeTransport,
  presentation: BridgePresentation,
): GenOfficeDesktopBridge {
  let loaded: LoadedContent | null = null;
  const target: Record<string, unknown> = {
    getLanguage: async () => presentation.language,
    getTheme: async () => presentation.theme,
    onLanguageChanged: noopSubscription,
    onThemeChanged: noopSubscription,
    onChromePressed: noopSubscription,
    getRecentFiles: async () => [],
    getAiSettings: async () => ({
      provider: 'custom' as const,
      providers: {},
      gskToolsEnabled: false as const,
    }),
    consumeNewBlankDoc: async () => false as const,
    consumeAiDocContent: async () => null,
    docPasswordIntentRevision: async () => 0 as const,
    onOpenDocx: noopSubscription,
    onRenamedDocx: noopSubscription,
    onTeardown: noopSubscription,
    onAiStream: noopSubscription,
    onMenuCommand: noopSubscription,
    onCloseCheck: noopSubscription,
    onCloseSaveRequest: noopSubscription,
    reportViewMenuState: () => undefined,
    reportCloseCheck: () => undefined,
    reportCloseSaveResult: () => undefined,
    async consumePendingOpenDocx() {
      loaded = requireLoadedContent(await transport.request('content.load', {}));
      return {
        path: `content://${loaded.contentIdentity}`,
        name: loaded.fileName,
        data: loaded.bytes,
        hash: loaded.blobDigest.slice('sha256:'.length),
      };
    },
    async saveDocx(_path: string, data: ArrayBuffer) {
      if (loaded === null) throw new Error('content must be loaded before settlement');
      try {
        const receipt = requireReceipt(
          await transport.request('content.settle', {
            expectedOwnerRevision: loaded.ownerRevision,
            bytes: data,
            operationId: presentation.operationId(),
          }),
        );
        loaded = { ...loaded, ownerRevision: receipt.ownerRevision, blobDigest: receipt.blobDigest };
        return { ok: true as const };
      } catch (error) {
        if ((error as RemoteBridgeError).code === 'owner_revision_conflict') {
          return { ok: false as const, reason: 'external-modified' as const };
        }
        throw error;
      }
    },
    async fontMetrics(family: string) {
      if (family.length === 0 || family.length > 128) throw new Error('invalid font family');
      return transport.request('surface.fontMetric', { family });
    },
    getPathForFile: () => {
      throw new BridgeDeniedError('getPathForFile');
    },
  };
  for (const method of DENIED_ASYNC_METHODS) {
    if (!(method in target)) {
      target[method] = async () => {
        throw new BridgeDeniedError(method);
      };
    }
  }

  return new Proxy(target, {
    get(current, property, receiver) {
      if (typeof property === 'symbol') return Reflect.get(current, property, receiver);
      if (!(property in current)) throw new Error(`unknown bridge method: ${property}`);
      return Reflect.get(current, property, receiver);
    },
    has(current, property) {
      return property in current;
    },
    set() {
      return false;
    },
  }) as GenOfficeDesktopBridge;
}

interface BridgeConnectMessage {
  v: 1;
  kind: 'cat-cafe-content-editor-connect';
  bridgeVersion: '1.0.0';
  sessionToken: string;
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

function isConnectMessage(value: unknown): value is BridgeConnectMessage {
  const record = requireObject(value, 'bridge connect');
  return (
    record.v === 1 &&
    record.kind === 'cat-cafe-content-editor-connect' &&
    record.bridgeVersion === '1.0.0' &&
    typeof record.sessionToken === 'string' &&
    record.sessionToken.length >= 32
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

  constructor(target: Window) {
    this.#connected = new Promise((resolve) => {
      const receiveConnect = (event: MessageEvent<unknown>): void => {
        if (event.source !== target.parent || event.ports.length !== 1) return;
        try {
          if (!isConnectMessage(event.data)) return;
        } catch {
          return;
        }
        const connect = event.data;
        target.removeEventListener('message', receiveConnect);
        this.#port = event.ports[0] ?? null;
        this.#sessionToken = connect.sessionToken;
        if (this.#port === null) return;
        this.#port.addEventListener('message', (message) => this.#receive(message));
        this.#port.start();
        resolve();
      };
      target.addEventListener('message', receiveConnect);
    });
  }

  async request(operation: HostBridgeOperation, payload: unknown): Promise<unknown> {
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
    let record: Record<string, unknown>;
    try {
      record = requireObject(event.data, 'bridge response');
    } catch {
      return;
    }
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
      const error = new Error(response.error?.message ?? 'Host bridge request failed') as RemoteBridgeError;
      if (response.error?.code !== undefined) error.code = response.error.code;
      pending.reject(error);
    }
  }
}

export function installGenOfficeHostBridge(target: Window): void {
  installNetworkDeny(target);
  target.localStorage.setItem('aidocs.showAi', '0');
  const transport = new MessagePortTransport(target);
  const cryptoSource = target.crypto;
  const desktop = createGenOfficeDesktopBridge(transport, {
    operationId: () => cryptoSource.randomUUID(),
    language: 'zh',
    theme: 'system',
  });
  Object.defineProperty(target, 'desktop', {
    value: desktop,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(target, 'projectApi', {
    value: undefined,
    configurable: false,
    enumerable: false,
    writable: false,
  });
}

if (typeof window !== 'undefined') installGenOfficeHostBridge(window);

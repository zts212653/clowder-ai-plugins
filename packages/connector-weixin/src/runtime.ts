import {
  WeixinAdapter,
  type WeixinInboundMessage,
  type WeixinRuntimeOptions,
  type WeixinSessionStateStore,
} from './WeixinAdapter.js';
import type { ConnectorLogger } from './types.js';

export interface WeixinRuntimeConfig extends WeixinRuntimeOptions {
  readonly botToken: string;
}

export interface WeixinHostInboundMessage {
  readonly externalConversationId: string;
  readonly externalSenderId: string;
  readonly providerMessageId: string;
  readonly text: string;
  readonly attachments?: readonly Readonly<{
    type: 'image' | 'file' | 'audio';
    platformKey: string;
    fileName?: string;
  }>[];
}

export interface WeixinRuntimeHost {
  deliver(message: WeixinHostInboundMessage): Promise<void>;
}

export interface WeixinRuntimeAdapter {
  readonly connectorId: string;
  restoreSessionState(): Promise<void>;
  startPolling(handler: (message: WeixinInboundMessage) => Promise<void>): void | Promise<void>;
  stopPolling(): Promise<void>;
  hasBotToken(): boolean;
  isPolling(): boolean;
  setBotToken(token: string): void;
  disconnect(): Promise<void>;
  sendReply: WeixinAdapter['sendReply'];
  sendMedia: WeixinAdapter['sendMedia'];
}

export interface WeixinConnectorRuntime<Adapter extends WeixinRuntimeAdapter = WeixinAdapter> {
  readonly outbound: Adapter;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Adopt a bot token in-process and begin polling (idles until the runtime is started). */
  connect(botToken: string): Promise<void>;
  /** Stop polling and drop the connection in-process (bot token and session cleared). */
  disconnect(): Promise<void>;
  /** True when a bot token is adopted and provider polling is live. */
  isConnected(): boolean;
}

export interface WeixinConnectorRuntimeOptions<Adapter extends WeixinRuntimeAdapter = WeixinAdapter> {
  readonly config: WeixinRuntimeConfig;
  readonly state: WeixinSessionStateStore;
  readonly host: WeixinRuntimeHost;
  readonly logger: ConnectorLogger;
  readonly createAdapter?: (
    botToken: string,
    logger: ConnectorLogger,
    state: WeixinSessionStateStore,
    runtimeOptions: WeixinRuntimeOptions,
  ) => Adapter;
}

function hostMessage(message: WeixinInboundMessage): WeixinHostInboundMessage {
  const attachments = message.attachments?.map((attachment) => ({
    type: attachment.type,
    platformKey: attachment.mediaUrl,
    ...(attachment.fileName === undefined ? {} : { fileName: attachment.fileName }),
  }));
  return {
    externalConversationId: message.chatId,
    externalSenderId: message.senderId,
    providerMessageId: message.messageId,
    text: message.text,
    ...(attachments === undefined ? {} : { attachments }),
  };
}

export function createWeixinConnectorRuntime<Adapter extends WeixinRuntimeAdapter = WeixinAdapter>(
  options: WeixinConnectorRuntimeOptions<Adapter>,
): WeixinConnectorRuntime<Adapter> {
  const initialToken = options.config.botToken.trim();
  const { botToken: _botToken, ...runtimeOptions } = options.config;
  const createAdapter = options.createAdapter ?? ((
    token: string,
    logger: ConnectorLogger,
    state: WeixinSessionStateStore,
    value: WeixinRuntimeOptions,
  ) => new WeixinAdapter(token, logger, state, value) as unknown as Adapter);
  // The Host starts the runtime healthy BEFORE credentials exist: without a token
  // the runtime stays idle (no connect, no polling) until QR login adopts one.
  let outbound: Adapter | undefined = initialToken.length > 0
    ? createAdapter(initialToken, options.logger, options.state, runtimeOptions)
    : undefined;
  let state: 'idle' | 'starting' | 'running' | 'stopped' = 'idle';
  // Armed = start() ran and stop() has not. Unlike startPromise, disconnect()
  // never clears it: a reconnect after an owner disconnect must still begin
  // polling (Host write-back does not restart the plugin).
  let armed = false;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  // Bumped by every connect()/disconnect() that supersedes in-flight work: a
  // polling chain captured an older generation must not start polling on a
  // stale adapter or publish state after the connection it belongs to was
  // dropped or replaced.
  let generation = 0;
  const deliverIfRunning = async (message: WeixinInboundMessage) => {
    if (state !== 'running') return;
    await options.host.deliver(hostMessage(message));
  };
  const requireOutbound = (): Adapter => {
    if (outbound === undefined) {
      throw new Error('WeChat connector is not connected — complete QR code login (weixin_qr_login) first');
    }
    return outbound;
  };
  const beginPolling = (): Promise<void> => {
    const adapter = requireOutbound();
    const generationAtStart = generation;
    state = 'starting';
    startPromise = Promise.resolve()
      .then(() => adapter.restoreSessionState())
      .then(() => {
        // disconnect() or a newer connect() superseded this chain while the
        // session state was restoring: polling must not start on the stale
        // adapter (it may already be disconnected, with an empty token).
        if (generationAtStart !== generation) return;
        return adapter.startPolling(deliverIfRunning);
      })
      .then(() => {
        if (state !== 'stopped' && generationAtStart === generation) {
          state = 'running';
          options.logger.info('[WeixinRuntime] Provider polling started');
        }
      })
      .catch((error: unknown) => {
        if (state !== 'stopped' && generationAtStart === generation) {
          state = 'idle';
          startPromise = undefined;
        }
        throw error;
      });
    return startPromise;
  };

  return {
    get outbound() {
      return requireOutbound();
    },
    start() {
      if (state === 'stopped') return Promise.reject(new Error('Weixin connector runtime has been stopped'));
      if (startPromise !== undefined) return startPromise;
      armed = true;
      if (outbound === undefined) {
        // Armed but idle: no provider I/O until connect() adopts a token.
        startPromise = Promise.resolve();
        return startPromise;
      }
      return beginPolling();
    },
    connect(botToken: string) {
      const token = botToken.trim();
      if (token.length === 0) return Promise.reject(new TypeError('botToken must be a non-empty value'));
      if (state === 'stopped') return Promise.reject(new Error('Weixin connector runtime has been stopped'));
      if (outbound === undefined) {
        outbound = createAdapter(token, options.logger, options.state, runtimeOptions);
      } else {
        outbound.setBotToken(token);
      }
      if (!armed || state === 'running') return Promise.resolve();
      generation += 1;
      return beginPolling();
    },
    async disconnect() {
      // Supersede any polling chain still restoring session state: it belongs
      // to the connection being dropped and must not publish state afterwards.
      generation += 1;
      const adapter = outbound;
      outbound = undefined;
      state = 'idle';
      startPromise = undefined;
      if (adapter !== undefined) await adapter.disconnect();
    },
    isConnected() {
      return outbound !== undefined && outbound.hasBotToken() && outbound.isPolling();
    },
    stop() {
      if (stopPromise !== undefined) return stopPromise;
      armed = false;
      if (state === 'idle') {
        state = 'stopped';
        return Promise.resolve();
      }
      state = 'stopped';
      stopPromise = (async () => {
        await startPromise?.catch(() => undefined);
        await outbound?.stopPolling();
      })();
      return stopPromise;
    },
  };
}

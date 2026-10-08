import {
  WeComBotAdapter,
  type WeComBotAdapterOptions,
  type WeComBotInboundMessage,
} from './WeComBotAdapter.js';
import type { ConnectorLogger } from './types.js';

export interface WeComBotRuntimeConfig {
  readonly botId: string;
  readonly botSecret: string;
}

export interface WeComBotHostInboundMessage {
  readonly externalConversationId: string;
  readonly providerMessageId: string;
  readonly text: string;
  readonly attachments?: readonly Readonly<{
    type: 'image' | 'file' | 'audio';
    platformKey: string;
    fileName?: string;
  }>[];
  readonly sender: Readonly<{ id: string }>;
  readonly conversation: Readonly<{ type: 'direct' | 'group' }>;
}

export interface WeComBotRuntimeHost {
  deliver(message: WeComBotHostInboundMessage): Promise<void>;
}

export interface WeComBotRuntimeAdapter {
  readonly connectorId: string;
  startStream(handler: (message: WeComBotInboundMessage) => Promise<void>): Promise<void>;
  stopStream(): Promise<void>;
  getConnectionState(): 'connected' | 'disconnected' | 'reconnecting';
  sendFormattedReply: WeComBotAdapter['sendFormattedReply'];
  sendMedia: WeComBotAdapter['sendMedia'];
  sendReply: WeComBotAdapter['sendReply'];
}

export interface WeComBotConnectorRuntime<Adapter extends WeComBotRuntimeAdapter = WeComBotAdapter> {
  readonly outbound: Adapter;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Adopt credentials in-process and (re)start the provider stream with them. */
  connect(config: Readonly<WeComBotRuntimeConfig>): Promise<void>;
  /** Stop the provider stream and drop the in-process connection (configuration values untouched). */
  disconnect(): Promise<void>;
  /** True when the provider WebSocket is connected. */
  isConnected(): boolean;
  /** Current provider stream state (connected / disconnected / reconnecting). */
  getConnectionState(): 'connected' | 'disconnected' | 'reconnecting';
}

export interface WeComBotConnectorRuntimeOptions<Adapter extends WeComBotRuntimeAdapter = WeComBotAdapter> {
  readonly config: WeComBotRuntimeConfig;
  readonly host: WeComBotRuntimeHost;
  readonly logger: ConnectorLogger;
  readonly createAdapter?: (logger: ConnectorLogger, config: WeComBotAdapterOptions) => Adapter;
}

function trimValue(value: string): string {
  return value.trim();
}

function hostMessage(message: WeComBotInboundMessage): WeComBotHostInboundMessage {
  const attachments = message.attachments
    ?.filter((attachment) => attachment.url !== undefined)
    .map((attachment) => ({
      type: attachment.type === 'voice' ? 'audio' as const : attachment.type,
      platformKey: `${attachment.url!}${attachment.aesKey ? `|aeskey=${attachment.aesKey}` : ''}`,
      ...(attachment.fileName === undefined ? {} : { fileName: attachment.fileName }),
    }));
  return {
    externalConversationId: message.chatId,
    providerMessageId: message.messageId,
    text: message.text,
    ...(attachments === undefined ? {} : { attachments }),
    sender: { id: message.senderId },
    conversation: { type: message.chatType === 'group' ? 'group' : 'direct' },
  };
}

export function createWeComBotConnectorRuntime<Adapter extends WeComBotRuntimeAdapter = WeComBotAdapter>(
  options: WeComBotConnectorRuntimeOptions<Adapter>,
): WeComBotConnectorRuntime<Adapter> {
  const createAdapter = options.createAdapter ?? ((logger: ConnectorLogger, value: WeComBotAdapterOptions) => (
    new WeComBotAdapter(logger, value) as unknown as Adapter
  ));
  // Credentials may be filled only after the plugin is enabled — without them the
  // runtime stays healthy and idle (no provider stream) until connect() adopts them.
  let outbound: Adapter | undefined = (() => {
    const botId = trimValue(options.config.botId);
    const secret = trimValue(options.config.botSecret);
    return botId.length > 0 && secret.length > 0
      ? createAdapter(options.logger, { botId, secret })
      : undefined;
  })();
  let state: 'idle' | 'starting' | 'running' | 'stopped' = 'idle';
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const deliverIfRunning = async (message: WeComBotInboundMessage) => {
    if (state !== 'running') return;
    await options.host.deliver(hostMessage(message));
  };
  const requireOutbound = (): Adapter => {
    if (outbound === undefined) {
      throw new Error('WeCom Bot connector is not connected — complete 验证并连接 (wecom_validate) first');
    }
    return outbound;
  };
  const beginStream = (): Promise<void> => {
    const adapter = requireOutbound();
    state = 'starting';
    startPromise = adapter.startStream(deliverIfRunning)
      .then(() => {
        if (state !== 'stopped') {
          state = 'running';
          options.logger.info('[WeComBotRuntime] Provider stream started');
        }
      })
      .catch((error: unknown) => {
        if (state !== 'stopped') {
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
      if (state === 'stopped') return Promise.reject(new Error('WeCom Bot connector runtime has been stopped'));
      if (startPromise !== undefined) return startPromise;
      if (outbound === undefined) {
        // Armed but idle: no provider I/O until connect() adopts credentials.
        startPromise = Promise.resolve();
        return startPromise;
      }
      return beginStream();
    },
    async connect(config) {
      const botId = trimValue(config.botId);
      const secret = trimValue(config.botSecret);
      if (botId.length === 0 || secret.length === 0) {
        throw new TypeError('botId and botSecret must be non-empty values');
      }
      if (state === 'stopped') throw new Error('WeCom Bot connector runtime has been stopped');
      await startPromise?.catch(() => undefined);
      await outbound?.stopStream().catch(() => undefined);
      outbound = createAdapter(options.logger, { botId, secret });
      state = 'idle';
      startPromise = undefined;
      await beginStream();
    },
    async disconnect() {
      const adapter = outbound;
      outbound = undefined;
      state = 'idle';
      startPromise = undefined;
      if (adapter !== undefined) await adapter.stopStream();
    },
    isConnected() {
      return outbound !== undefined && outbound.getConnectionState() === 'connected';
    },
    getConnectionState() {
      return outbound?.getConnectionState() ?? 'disconnected';
    },
    stop() {
      if (stopPromise !== undefined) return stopPromise;
      if (state === 'idle') {
        state = 'stopped';
        return Promise.resolve();
      }
      state = 'stopped';
      stopPromise = (async () => {
        await startPromise?.catch(() => undefined);
        await outbound?.stopStream();
      })();
      return stopPromise;
    },
  };
}

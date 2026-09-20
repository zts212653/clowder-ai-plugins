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
  sendReply: WeixinAdapter['sendReply'];
  sendMedia: WeixinAdapter['sendMedia'];
}

export interface WeixinConnectorRuntime<Adapter extends WeixinRuntimeAdapter = WeixinAdapter> {
  readonly outbound: Adapter;
  start(): Promise<void>;
  stop(): Promise<void>;
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
  const botToken = options.config.botToken.trim();
  if (botToken.length === 0) throw new TypeError('botToken must be a non-empty declared secret');
  const { botToken: _botToken, ...runtimeOptions } = options.config;
  const createAdapter = options.createAdapter ?? ((
    token: string,
    logger: ConnectorLogger,
    state: WeixinSessionStateStore,
    value: WeixinRuntimeOptions,
  ) => new WeixinAdapter(token, logger, state, value) as unknown as Adapter);
  const outbound = createAdapter(botToken, options.logger, options.state, runtimeOptions);
  let state: 'idle' | 'starting' | 'running' | 'stopped' = 'idle';
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const deliverIfRunning = async (message: WeixinInboundMessage) => {
    if (state !== 'running') return;
    await options.host.deliver(hostMessage(message));
  };

  return {
    outbound,
    start() {
      if (state === 'stopped') return Promise.reject(new Error('Weixin connector runtime has been stopped'));
      if (startPromise !== undefined) return startPromise;
      state = 'starting';
      startPromise = Promise.resolve()
        .then(() => outbound.restoreSessionState())
        .then(() => outbound.startPolling(deliverIfRunning))
        .then(() => {
          if (state !== 'stopped') {
            state = 'running';
            options.logger.info('[WeixinRuntime] Provider polling started');
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
        await outbound.stopPolling();
      })();
      return stopPromise;
    },
  };
}

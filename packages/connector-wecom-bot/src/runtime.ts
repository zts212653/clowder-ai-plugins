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
  sendFormattedReply: WeComBotAdapter['sendFormattedReply'];
  sendMedia: WeComBotAdapter['sendMedia'];
  sendReply: WeComBotAdapter['sendReply'];
}

export interface WeComBotConnectorRuntime<Adapter extends WeComBotRuntimeAdapter = WeComBotAdapter> {
  readonly outbound: Adapter;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface WeComBotConnectorRuntimeOptions<Adapter extends WeComBotRuntimeAdapter = WeComBotAdapter> {
  readonly config: WeComBotRuntimeConfig;
  readonly host: WeComBotRuntimeHost;
  readonly logger: ConnectorLogger;
  readonly createAdapter?: (logger: ConnectorLogger, config: WeComBotAdapterOptions) => Adapter;
}

function required(value: string, key: keyof WeComBotRuntimeConfig): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${key} must be a non-empty declared value`);
  return normalized;
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
  const config = {
    botId: required(options.config.botId, 'botId'),
    secret: required(options.config.botSecret, 'botSecret'),
  };
  const createAdapter = options.createAdapter ?? ((logger: ConnectorLogger, value: WeComBotAdapterOptions) => (
    new WeComBotAdapter(logger, value) as unknown as Adapter
  ));
  const outbound = createAdapter(options.logger, config);
  let state: 'idle' | 'starting' | 'running' | 'stopped' = 'idle';
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const deliverIfRunning = async (message: WeComBotInboundMessage) => {
    if (state !== 'running') return;
    await options.host.deliver(hostMessage(message));
  };

  return {
    outbound,
    start() {
      if (state === 'stopped') return Promise.reject(new Error('WeCom Bot connector runtime has been stopped'));
      if (startPromise !== undefined) return startPromise;
      state = 'starting';
      startPromise = outbound.startStream(deliverIfRunning)
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
        await outbound.stopStream();
      })();
      return stopPromise;
    },
  };
}

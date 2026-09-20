import {
  DingTalkAdapter,
  type DingTalkAdapterOptions,
  type DingTalkInboundMessage,
} from './DingTalkAdapter.js';
import type { ConnectorLogger } from './types.js';

export interface DingTalkRuntimeConfig {
  readonly appKey: string;
  readonly appSecret: string;
  readonly robotCode?: string;
}

export interface DingTalkInboundAttachment {
  readonly type: 'image' | 'file' | 'audio';
  readonly platformKey: string;
  readonly fileName?: string;
  readonly duration?: number;
}

/** Provider facts only; the Host resolves the authenticated connector binding. */
export interface DingTalkHostInboundMessage {
  readonly externalConversationId: string;
  readonly providerConversationId: string;
  readonly providerMessageId: string;
  readonly text: string;
  readonly attachments?: readonly DingTalkInboundAttachment[];
  readonly sender?: { readonly id: string; readonly name?: string };
  readonly chatType: 'p2p' | 'group';
  readonly chatName?: string;
}

export interface DingTalkRuntimeHost {
  deliver(message: DingTalkHostInboundMessage): Promise<void>;
}

export interface DingTalkOutbound {
  readonly connectorId: string;
  sendReply(
    externalChatId: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
}

export interface DingTalkRuntimeAdapter extends DingTalkOutbound {
  startStream(handler: (message: DingTalkInboundMessage) => Promise<void>): Promise<void>;
  stopStream(): Promise<void>;
  resolveSenderName(senderId: string): string | undefined;
  resolveConversationTitle(chatId: string): string | undefined;
}

export interface DingTalkConnectorRuntime<Adapter extends DingTalkRuntimeAdapter = DingTalkAdapter> {
  readonly outbound: Adapter;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DingTalkConnectorRuntimeOptions<Adapter extends DingTalkRuntimeAdapter = DingTalkAdapter> {
  readonly config: DingTalkRuntimeConfig;
  readonly host: DingTalkRuntimeHost;
  readonly logger: ConnectorLogger;
  readonly createAdapter?: (config: DingTalkAdapterOptions, logger: ConnectorLogger) => Adapter;
}

function required(value: string, key: 'appKey' | 'appSecret'): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${key} must be a non-empty declared value`);
  return normalized;
}

function hostMessage(
  adapter: DingTalkRuntimeAdapter,
  message: DingTalkInboundMessage,
): DingTalkHostInboundMessage {
  const attachments = message.attachments
    ?.filter(attachment => attachment.downloadCode !== undefined)
    .map(attachment => ({
      type: attachment.type,
      platformKey: attachment.downloadCode!,
      ...(attachment.fileName === undefined ? {} : { fileName: attachment.fileName }),
      ...(attachment.duration === undefined ? {} : { duration: attachment.duration }),
    }));
  const senderName = message.senderNick ?? adapter.resolveSenderName(message.senderId);
  const chatName = message.conversationTitle ?? adapter.resolveConversationTitle(message.chatId);
  const sender = message.chatType === 'group' && message.senderId !== 'unknown'
    ? { id: message.senderId, ...(senderName === undefined ? {} : { name: senderName }) }
    : undefined;
  return {
    externalConversationId: message.chatId,
    providerConversationId: message.conversationId,
    providerMessageId: message.messageId,
    text: message.text,
    chatType: message.chatType,
    ...(attachments === undefined ? {} : { attachments }),
    ...(sender === undefined ? {} : { sender }),
    ...(chatName === undefined ? {} : { chatName }),
  };
}

/**
 * Composes DingTalk provider I/O from explicit manifest-declared values.
 * Binding lookup, admission, wake policy, retry, and settlement remain Host
 * responsibilities and are intentionally absent from the delivered payload.
 */
export function createDingTalkConnectorRuntime<Adapter extends DingTalkRuntimeAdapter = DingTalkAdapter>(
  options: DingTalkConnectorRuntimeOptions<Adapter>,
): DingTalkConnectorRuntime<Adapter> {
  const config: DingTalkAdapterOptions = {
    appKey: required(options.config.appKey, 'appKey'),
    appSecret: required(options.config.appSecret, 'appSecret'),
    ...(options.config.robotCode === undefined ? {} : { robotCode: options.config.robotCode }),
  };
  const createAdapter = options.createAdapter ?? ((value: DingTalkAdapterOptions, logger: ConnectorLogger) => (
    new DingTalkAdapter(logger, value) as unknown as Adapter
  ));
  const outbound = createAdapter(config, options.logger);
  let state: 'idle' | 'starting' | 'running' | 'stopped' = 'idle';
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const deliverIfRunning = async (message: DingTalkInboundMessage) => {
    if (state !== 'running') return;
    await options.host.deliver(hostMessage(outbound, message));
  };

  return {
    outbound,
    start() {
      if (state === 'stopped') return Promise.reject(new Error('DingTalk connector runtime has been stopped'));
      if (startPromise !== undefined) return startPromise;
      state = 'starting';
      startPromise = outbound
        .startStream(deliverIfRunning)
        .then(() => {
          if (state !== 'stopped') {
            state = 'running';
            options.logger.info('[DingTalkRuntime] Provider stream started');
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
      stopPromise = outbound.stopStream();
      return stopPromise;
    },
  };
}

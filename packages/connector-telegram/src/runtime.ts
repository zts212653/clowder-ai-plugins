import {
  TelegramAdapter,
  type InlineFinalPersistence,
  type TelegramInboundMessage,
} from './TelegramAdapter.js';
import { normalizeTelegramBotToken } from './token.js';
import type { ConnectorLogger } from './types.js';

export interface TelegramRuntimeConfig {
  /** Manifest-declared secret projected explicitly by the Host. */
  readonly botToken: string;
}

export interface TelegramInboundAttachment {
  readonly type: 'image' | 'file' | 'audio';
  readonly platformKey: string;
  readonly fileName?: string;
  readonly duration?: number;
}

/**
 * Provider facts delivered to the Host-owned connector binding layer.
 *
 * This deliberately carries no Clowder address or thread identifier: only the
 * Host may resolve the installed connector instance to an authenticated
 * `connector_binding` and derive admission or wake behavior.
 */
export interface TelegramHostInboundMessage {
  readonly externalConversationId: string;
  readonly externalSenderId: string;
  readonly providerMessageId: string;
  readonly text: string;
  readonly attachments?: readonly TelegramInboundAttachment[];
}

export interface TelegramRuntimeHost {
  deliver(message: TelegramHostInboundMessage): Promise<void>;
}

export interface TelegramOutbound {
  readonly connectorId: string;
  sendReply(
    externalChatId: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
}

export interface TelegramRuntimeAdapter extends TelegramOutbound {
  startPolling(handler: (message: TelegramInboundMessage) => Promise<void>): void | Promise<void>;
  stopPolling(): Promise<void>;
}

export interface TelegramConnectorRuntime<Adapter extends TelegramRuntimeAdapter = TelegramAdapter> {
  /** Provider egress implementation consumed by the Host's generic delivery adapter. */
  readonly outbound: Adapter;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** True while the provider polling loop is running. */
  isPolling(): boolean;
}

export interface TelegramConnectorRuntimeOptions<Adapter extends TelegramRuntimeAdapter = TelegramAdapter> {
  readonly config: TelegramRuntimeConfig;
  readonly host: TelegramRuntimeHost;
  readonly logger: ConnectorLogger;
  /** Durable backing for the lifecycle-keyed inline-final map; omitting keeps it in-memory only. */
  readonly inlineFinalPersistence?: InlineFinalPersistence;
  readonly createAdapter?: (normalizedBotToken: string, logger: ConnectorLogger, persistence?: InlineFinalPersistence) => Adapter;
}

function hostMessage(message: TelegramInboundMessage): TelegramHostInboundMessage {
  const attachments = message.attachments?.map(attachment => ({
    type: attachment.type,
    platformKey: attachment.telegramFileId,
    ...(attachment.fileName === undefined ? {} : { fileName: attachment.fileName }),
    ...(attachment.duration === undefined ? {} : { duration: attachment.duration }),
  }));
  return {
    externalConversationId: message.chatId,
    externalSenderId: message.senderId,
    providerMessageId: message.messageId,
    text: message.text,
    ...(attachments === undefined ? {} : { attachments }),
  };
}

/**
 * Composes Telegram provider I/O without importing Core or reading ambient
 * process state. The Host injects the declared secret and receives provider
 * facts; binding lookup, admission, wake routing, retry, and settlement remain
 * outside this package runtime.
 */
export function createTelegramConnectorRuntime<Adapter extends TelegramRuntimeAdapter = TelegramAdapter>(
  options: TelegramConnectorRuntimeOptions<Adapter>,
): TelegramConnectorRuntime<Adapter> {
  const token = normalizeTelegramBotToken(options.config.botToken);
  if (token === null) throw new TypeError('botToken must be a valid Telegram Bot token');

  const createAdapter = options.createAdapter ?? ((value: string, logger: ConnectorLogger, persistence?: InlineFinalPersistence) => (
    new TelegramAdapter(value, logger, persistence) as unknown as Adapter
  ));
  const outbound = createAdapter(token, options.logger, options.inlineFinalPersistence);
  let state: 'idle' | 'starting' | 'running' | 'stopped' = 'idle';
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const deliverIfRunning = async (message: TelegramInboundMessage) => {
    if (state !== 'running') return;
    await options.host.deliver(hostMessage(message));
  };

  return {
    outbound,
    start() {
      if (state === 'stopped') return Promise.reject(new Error('Telegram connector runtime has been stopped'));
      if (startPromise !== undefined) return startPromise;
      state = 'starting';
      startPromise = Promise.resolve()
        .then(() => outbound.startPolling(deliverIfRunning))
        .then(() => {
          if (state !== 'stopped') {
            state = 'running';
            options.logger.info('[TelegramRuntime] Provider polling started');
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
    isPolling() {
      return state === 'running';
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

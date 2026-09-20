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
  isStreamLive(): boolean;
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
  /** Watchdog poll interval for provider stream liveness (default 15s). */
  readonly streamWatchdogIntervalMs?: number;
  /** Backoff base delay before reconnecting a stream the watchdog found dead (default 5s). */
  readonly reconnectDelayMs?: number;
  /** Backoff delay ceiling (default 60s). Exponential backoff doubles from the
   * base delay with ±20% jitter until this cap. */
  readonly reconnectMaxDelayMs?: number;
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
  let watchdogTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const watchdogIntervalMs = options.streamWatchdogIntervalMs ?? 15_000;
  const reconnectBaseDelayMs = options.reconnectDelayMs ?? 5_000;
  const reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 60_000;
  let reconnectAttempts = 0;
  const nextBackoffMs = (): number => {
    const exponential = Math.min(reconnectBaseDelayMs * 2 ** reconnectAttempts, reconnectMaxDelayMs);
    reconnectAttempts += 1;
    return Math.round(exponential * (0.8 + Math.random() * 0.4));
  };
  const deliverIfRunning = async (message: DingTalkInboundMessage) => {
    if (state !== 'running') return;
    await options.host.deliver(hostMessage(outbound, message));
  };

  // G1: the SDK retries a dropped or revoked-credential stream silently, so
  // the runtime polls the client truth (connected && registered) and owns
  // reconnect supervision: dead stream → state exits 'running' → error log →
  // backoff → drain + fresh startStream, until stop().
  const scheduleReconnect = (reason: string): void => {
    if (state === 'stopped' || reconnectTimer !== undefined) return;
    const delayMs = nextBackoffMs();
    options.logger.error(`[DingTalkRuntime] ${reason}; reconnecting in ${delayMs}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (state !== 'idle') return; // stop() or a fresh start() superseded it
      state = 'starting';
      startPromise = outbound.stopStream()
        .catch(() => undefined)
        .then(() => outbound.startStream(deliverIfRunning))
        .then(() => {
          if (state !== 'stopped') {
            reconnectAttempts = 0;
            armWatchdog();
            state = 'running';
            options.logger.info('[DingTalkRuntime] Provider stream started');
          }
        })
        .catch((error: unknown) => {
          // Timer-context rejection: never rethrow (unhandled rejection);
          // log and reschedule the backoff instead.
          if (state === 'stopped') return;
          state = 'idle';
          startPromise = undefined;
          options.logger.error({ error }, '[DingTalkRuntime] Reconnect attempt failed');
          scheduleReconnect('reconnect attempt failed');
        });
    }, delayMs);
  };

  const armWatchdog = (): void => {
    // Armed only on transitions into 'running': arming at the top of start()
    // leaks the interval for the process lifetime when startStream rejects
    // (the interval keeps the event loop alive even though the runtime
    // never left 'idle').
    if (watchdogTimer !== undefined) return;
    watchdogTimer = setInterval(onWatchdog, watchdogIntervalMs);
  };

  const onWatchdog = (): void => {
    if (state !== 'running' || outbound.isStreamLive()) return;
    state = 'idle'; // no live inbound during reconnect
    startPromise = undefined;
    scheduleReconnect('provider stream is not live (connected/registered dropped)');
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
            reconnectAttempts = 0;
            armWatchdog();
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
      if (watchdogTimer !== undefined) {
        clearInterval(watchdogTimer);
        watchdogTimer = undefined;
      }
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
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

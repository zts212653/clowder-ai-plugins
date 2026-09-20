import * as lark from '@larksuiteoapi/node-sdk';

import {
  FeishuAdapter,
  type FeishuAdapterOptions,
  type FeishuCardAction,
  type FeishuInboundMessage,
} from './FeishuAdapter.js';
import { FeishuTokenManager } from './FeishuTokenManager.js';
import type { ConnectorLogger } from './types.js';

export interface FeishuRuntimeConfig {
  readonly appId: string;
  readonly appSecret: string;
  readonly connectionMode: 'webhook' | 'websocket';
  readonly verificationToken?: string;
  readonly groupBotMentionsJson?: string;
}

export interface FeishuWebhookInput { readonly body?: unknown }
export type FeishuWebhookResult =
  | Readonly<{ kind: 'challenge'; response: Readonly<{ challenge: string }> }>
  | Readonly<{ kind: 'processed'; messageId: string }>
  | Readonly<{ kind: 'skipped'; reason: string }>
  | Readonly<{ kind: 'error'; status: number; message: string }>;

export interface FeishuHostInboundMessage {
  readonly externalConversationId: string;
  readonly providerMessageId: string;
  readonly text: string;
  readonly attachments?: readonly Readonly<{
    type: 'image' | 'file' | 'audio';
    platformKey: string;
    fileName?: string;
    duration?: number;
  }>[];
  readonly sender?: Readonly<{ id: string; name?: string }>;
  readonly conversation: Readonly<{ type: 'direct' | 'group'; title?: string }>;
}

export interface FeishuRuntimeHost { deliver(message: FeishuHostInboundMessage): Promise<void> }

export interface FeishuRuntimeAdapter {
  readonly connectorId: string;
  isVerificationChallenge: FeishuAdapter['isVerificationChallenge'];
  verifyEventToken: FeishuAdapter['verifyEventToken'];
  parseEvent: FeishuAdapter['parseEvent'];
  parseCardAction: FeishuAdapter['parseCardAction'];
  resolveSenderName: FeishuAdapter['resolveSenderName'];
  resolveSenderNameFromChat: FeishuAdapter['resolveSenderNameFromChat'];
  resolveChatName: FeishuAdapter['resolveChatName'];
  resolveChatType: FeishuAdapter['resolveChatType'];
  setBotOpenId: FeishuAdapter['setBotOpenId'];
  sendFormattedReply: FeishuAdapter['sendFormattedReply'];
  sendMedia: FeishuAdapter['sendMedia'];
  sendReply: FeishuAdapter['sendReply'];
  _injectTokenManager?(manager: FeishuTokenManager): void;
}

interface FeishuWsClient {
  start(options: { eventDispatcher: lark.EventDispatcher }): Promise<void>;
  close(options?: { force?: boolean }): void;
}

/** SDK internals the teardown guard needs (verified against @larksuiteoapi/node-sdk 1.59.0). */
interface LarkWsInternals {
  start(options: { eventDispatcher: lark.EventDispatcher }): Promise<void>;
  close(options?: { force?: boolean }): void;
  pingLoop(): void;
  /**
   * Instance flag the SDK sets true while a connect attempt is in flight and
   * false once it settles (es/index.js reConnect finally, ~line 85412). With
   * `autoReconnect: false` a failed attempt logs 'connect failed' and returns
   * without touching the registered socket, so this flag is the observable
   * termination signal for fail-fast start.
   */
  isConnecting?: boolean;
  wsConfig: {
    getWSInstance(): unknown;
    setWSInstance(ws: unknown): void;
  };
}

const WS_START_TIMEOUT_MS = 30_000;
const WS_CONNECT_POLL_MS = 250;

function terminateWsInstance(ws: unknown): void {
  if (ws === null || ws === undefined || typeof ws !== 'object') return;
  const socket = ws as { removeAllListeners?: () => void; terminate?: () => void };
  socket.removeAllListeners?.();
  socket.terminate?.();
}

export interface PausableLarkWsClientHooks {
  /**
   * Invoked when the open socket emits 'close' without a stop() in flight.
   * The lark SDK cannot be trusted to surface this itself: with
   * `autoReconnect: false` its close handler returns before clearing the
   * registered socket (es/index.js ~85422), leaving a dead socket in the
   * registry with no callback. Reconnect supervision therefore lives here.
   */
  readonly onClose?: () => void;
}

/**
 * F2/F3: the lark WSClient cannot cancel a connection that is still
 * handshaking — `close()` only touches the socket registered after 'open',
 * so a stop() landing pre-open would leave an authenticated socket that
 * starts pingLoop and self-reconnects forever (an orphan nobody can kill).
 *
 * This facade makes teardown deterministic:
 * - `close()` terminates the current socket AND installs a birth guard that
 *   terminates any socket the SDK opens afterwards, plus a pingLoop no-op so
 *   a late 'open' cannot restart the ping timer.
 * - `start()` does not settle until the SDK has registered an open socket
 *   (lark `WSClient.start()` resolves in the same tick it kicks off
 *   `reConnect(true)`, so without this the runtime would report `running`
 *   before anything is connected), or aborts on stop/timeout/SDK give-up.
 * - after `start()` settles, the open socket's 'close' event drives the
 *   optional `onClose` hook (suppressed when `close()` initiated it), so the
 *   runtime can drop out of 'running' and schedule a reconnect instead of
 *   reporting a dead connection as live.
 *
 * `autoReconnect: false` is deliberate: SDK-owned reconnection was the F2
 * revival mechanism. Reconnect supervision belongs to the Host lifecycle.
 */
export class PausableLarkWsClient implements FeishuWsClient {
  private readonly inner: LarkWsInternals;
  private readonly hooks: PausableLarkWsClientHooks;
  private stopped = false;

  constructor(
    appId: string,
    appSecret: string,
    inner?: LarkWsInternals,
    hooks: PausableLarkWsClientHooks = {},
  ) {
    this.inner = inner ?? new lark.WSClient({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.info,
      autoReconnect: false,
    }) as unknown as LarkWsInternals;
    this.hooks = hooks;
  }

  async start(options: { eventDispatcher: lark.EventDispatcher }): Promise<void> {
    await this.inner.start(options);
    const deadline = Date.now() + WS_START_TIMEOUT_MS;
    for (;;) {
      if (this.stopped) throw new Error('Feishu WSClient stopped during connect');
      const socket = this.inner.wsConfig.getWSInstance();
      if (socket !== null) {
        this.watchSocketClose(socket);
        return;
      }
      // Fail fast when the SDK has already given up: with autoReconnect off a
      // failed handshake logs 'connect failed' and returns in about a second,
      // clearing isConnecting long before the 30s deadline. Without this the
      // start loop would spin the full timeout on every bad-credential boot.
      if (this.inner.isConnecting === false) {
        throw new Error('Feishu WSClient aborted the connection attempt before a socket opened');
      }
      if (Date.now() >= deadline) {
        throw new Error(`Feishu WSClient start timed out after ${WS_START_TIMEOUT_MS}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, WS_CONNECT_POLL_MS));
    }
  }

  private watchSocketClose(socket: unknown): void {
    const readyState = (socket as { readyState?: number }).readyState;
    if (readyState === 2 || readyState === 3) {
      // CLOSING/CLOSED before the listener was attached: surface it now so a
      // flash-close cannot slip through the attach window unnoticed.
      if (!this.stopped) this.hooks.onClose?.();
      return;
    }
    const emitter = socket as { on?: (event: string, listener: () => void) => void };
    if (typeof emitter !== 'object' || emitter === null || typeof emitter.on !== 'function') return;
    emitter.on('close', () => {
      if (this.stopped) return; // close() terminates the socket itself
      this.hooks.onClose?.();
    });
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    const wsConfig = this.inner.wsConfig;
    const originalSet = wsConfig.setWSInstance.bind(wsConfig);
    wsConfig.setWSInstance = (ws: unknown): void => {
      if (ws === null || ws === undefined) {
        originalSet(ws);
        return;
      }
      // Socket born after stop: kill before the SDK registers/uses it.
      terminateWsInstance(ws);
    };
    // A late 'open' would otherwise start the ping timer again.
    this.inner.pingLoop = () => undefined;
    terminateWsInstance(wsConfig.getWSInstance());
    this.inner.close({ force: true });
  }
}

export interface FeishuConnectorRuntime<Adapter extends FeishuRuntimeAdapter = FeishuAdapter> {
  readonly outbound: Adapter;
  start(): Promise<void>;
  stop(): Promise<void>;
  handleWebhook(input: FeishuWebhookInput): Promise<FeishuWebhookResult>;
}

export interface FeishuConnectorRuntimeOptions<Adapter extends FeishuRuntimeAdapter = FeishuAdapter> {
  readonly config: FeishuRuntimeConfig;
  readonly host: FeishuRuntimeHost;
  readonly logger: ConnectorLogger;
  readonly fetchFn?: typeof fetch;
  readonly createAdapter?: (
    appId: string,
    appSecret: string,
    logger: ConnectorLogger,
    options: FeishuAdapterOptions,
  ) => Adapter;
  readonly createWsClient?: (config: Readonly<{
    appId: string;
    appSecret: string;
    /** Unexpected-close notification; see PausableLarkWsClientHooks. */
    onClose?: () => void;
  }>) => FeishuWsClient;
  /** Reconnect backoff for an unexpectedly dropped ingress socket (default 5s). */
  readonly reconnectDelayMs?: number;
}

function required(value: string, key: 'appId' | 'appSecret'): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${key} must be a non-empty declared value`);
  return normalized;
}

function parseMentions(value: string | undefined): FeishuAdapterOptions['groupBotMentions'] {
  if (value === undefined || value.trim() === '') return undefined;
  let candidate: unknown;
  try { candidate = JSON.parse(value); } catch { throw new TypeError('groupBotMentionsJson must be valid JSON'); }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('groupBotMentionsJson must be an object');
  }
  const result: NonNullable<FeishuAdapterOptions['groupBotMentions']> = {};
  for (const [rawAlias, rawTarget] of Object.entries(candidate)) {
    const alias = rawAlias.trim();
    if (alias.length === 0 || rawTarget === null || typeof rawTarget !== 'object' || Array.isArray(rawTarget)) {
      throw new TypeError('groupBotMentionsJson entries must contain an alias and target object');
    }
    const target = rawTarget as Record<string, unknown>;
    if (typeof target.openId !== 'string' || target.openId.trim() === '') {
      throw new TypeError(`groupBotMentionsJson.${alias}.openId must be non-empty`);
    }
    result[alias] = {
      openId: target.openId.trim(),
      ...(typeof target.displayName === 'string' && target.displayName.trim() !== ''
        ? { displayName: target.displayName.trim() } : {}),
    };
  }
  return result;
}

export function requireFeishuWebhookInput(candidate: unknown): FeishuWebhookInput {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('feishu webhook input must be an object');
  }
  return { body: (candidate as Record<string, unknown>).body };
}

async function providerMessage(adapter: FeishuRuntimeAdapter, message: FeishuInboundMessage): Promise<FeishuHostInboundMessage> {
  let senderName = message.senderName;
  let chatName = message.chatName;
  if (message.chatType === 'group') {
    senderName ??= await adapter.resolveSenderName(message.senderId).catch(() => undefined);
    senderName ??= await adapter.resolveSenderNameFromChat(message.senderId, message.chatId).catch(() => undefined);
    chatName ??= await adapter.resolveChatName(message.chatId).catch(() => undefined);
  }
  const attachments = message.attachments?.map(attachment => ({
    type: attachment.type,
    platformKey: attachment.feishuKey,
    ...(attachment.fileName === undefined ? {} : { fileName: attachment.fileName }),
    ...(attachment.duration === undefined ? {} : { duration: attachment.duration }),
  }));
  const sender = message.chatType === 'group' && message.senderId !== 'unknown'
    ? { id: message.senderId, ...(senderName === undefined ? {} : { name: senderName }) }
    : undefined;
  return {
    externalConversationId: message.chatId,
    providerMessageId: message.messageId,
    text: message.text,
    ...(attachments === undefined ? {} : { attachments }),
    ...(sender === undefined ? {} : { sender }),
    conversation: {
      type: message.chatType === 'group' ? 'group' : 'direct',
      ...(chatName === undefined ? {} : { title: chatName }),
    },
  };
}

async function cardMessage(adapter: FeishuRuntimeAdapter, action: FeishuCardAction): Promise<FeishuHostInboundMessage | null> {
  const value = action.actionValue as { cmd?: string; args?: string };
  const command = typeof value.cmd === 'string' && value.cmd.startsWith('/')
    ? `${value.cmd}${typeof value.args === 'string' && value.args ? ` ${value.args}` : ''}`
    : action.option?.startsWith('/') ? action.option : undefined;
  const chatType = action.chatType ?? await adapter.resolveChatType(action.chatId);
  if (chatType === undefined) return null;
  return {
    externalConversationId: action.chatId,
    providerMessageId: `card-action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: command ?? JSON.stringify(action.actionValue),
    ...(command === undefined || action.senderId === '' ? {} : { sender: { id: action.senderId } }),
    conversation: { type: chatType === 'group' ? 'group' : 'direct' },
  };
}

export function createFeishuConnectorRuntime<Adapter extends FeishuRuntimeAdapter = FeishuAdapter>(
  options: FeishuConnectorRuntimeOptions<Adapter>,
): FeishuConnectorRuntime<Adapter> {
  const appId = required(options.config.appId, 'appId');
  const appSecret = required(options.config.appSecret, 'appSecret');
  const groupBotMentions = parseMentions(options.config.groupBotMentionsJson);
  const adapterOptions: FeishuAdapterOptions = {
    ...(options.config.verificationToken === undefined ? {} : { verificationToken: options.config.verificationToken }),
    ...(groupBotMentions === undefined ? {} : { groupBotMentions }),
  };
  const createAdapter = options.createAdapter ?? ((id, secret, logger, value) => (
    new FeishuAdapter(id, secret, logger, value) as unknown as Adapter
  ));
  const outbound = createAdapter(appId, appSecret, options.logger, adapterOptions);
  const tokenManager = new FeishuTokenManager({ appId, appSecret, ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }) });
  outbound._injectTokenManager?.(tokenManager);
  let state: 'idle' | 'starting' | 'running' | 'stopped' = 'idle';
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let wsClient: FeishuWsClient | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const reconnectDelayMs = options.reconnectDelayMs ?? 5_000;

  // Both return the real delivery outcome so callers can derive their
  // reported state from it instead of asserting success independently (G3):
  // a message dropped by the state recheck must never be reported 'processed'.
  const routeEvent = async (message: FeishuInboundMessage): Promise<boolean> => {
    if (state !== 'running') return false;
    const hostMessage = await providerMessage(outbound, message);
    // Group chats await name-resolution round-trips above; stop() landing in
    // that window must not still deliver (TOCTOU recheck after the await).
    if (state !== 'running') return false;
    await options.host.deliver(hostMessage);
    return true;
  };
  const routeCard = async (action: FeishuCardAction): Promise<'delivered' | 'not_running' | 'chat_type_unknown'> => {
    if (state !== 'running') return 'not_running';
    const message = await cardMessage(outbound, action);
    if (message === null) return 'chat_type_unknown';
    if (state !== 'running') return 'not_running';
    await options.host.deliver(message);
    return 'delivered';
  };

  const startIngress = async (): Promise<void> => {
    tokenManager.getTenantAccessToken().then(async token => {
      const response = await (options.fetchFn ?? globalThis.fetch)('https://open.feishu.cn/open-apis/bot/v3/info', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return;
      const data = await response.json() as { bot?: { open_id?: string } };
      if (data.bot?.open_id) outbound.setBotOpenId(data.bot.open_id);
    }).catch(error => options.logger.warn({ error }, '[FeishuRuntime] Bot identity resolution failed'));
    if (options.config.connectionMode !== 'websocket') return;
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: Record<string, unknown>) => {
        const parsed = outbound.parseEvent({ header: { event_type: 'im.message.receive_v1' }, event: data });
        if (parsed !== null) await routeEvent(parsed);
      },
      'card.action.trigger': async (data: Record<string, unknown>) => {
        const parsed = outbound.parseCardAction({ header: { event_type: 'card.action.trigger' }, event: data });
        if (parsed !== null) await routeCard(parsed);
      },
    });
    const createWs = options.createWsClient ?? ((value: Readonly<{ appId: string; appSecret: string; onClose?: () => void }>) => (
      new PausableLarkWsClient(value.appId, value.appSecret, undefined, { onClose: value.onClose })
    ));
    const client = createWs({ appId, appSecret, onClose: handleUnexpectedClose });
    wsClient = client;
    // PausableLarkWsClient.start() settles only once the socket is really
    // open (or stop/timeout/SDK give-up aborts it), so no outer timer needed.
    await client.start({ eventDispatcher: dispatcher });
  };

  // G1: the only trustworthy signal of a dead ingress is the socket's own
  // 'close' event (the lark SDK leaves a dead socket registered when
  // autoReconnect is off, so polling its registry would report 'alive').
  const handleUnexpectedClose = (): void => {
    // PausableLarkWsClient suppresses the callback for stop-initiated closes
    // via its stopped guard, so reaching here means an unexpected drop.
    if (state !== 'running') return;
    const dead = wsClient;
    wsClient = undefined;
    state = 'idle'; // no live inbound during reconnect; webhooks derive skipped
    startPromise = undefined;
    dead?.close({ force: true });
    scheduleReconnect('ingress socket closed unexpectedly');
  };

  const scheduleReconnect = (reason: string): void => {
    if (state === 'stopped' || reconnectTimer !== undefined) return;
    options.logger.error(`[FeishuRuntime] ${reason}; reconnecting in ${reconnectDelayMs}ms`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (state !== 'idle') return; // stop() or a fresh start() superseded it
      state = 'starting';
      startPromise = startIngress()
        .then(() => {
          if (state !== 'stopped') {
            state = 'running';
            options.logger.info('[FeishuRuntime] Provider ingress started');
          }
        })
        .catch((error: unknown) => {
          // Timer-context rejection: never rethrow (unhandled rejection);
          // log and reschedule the backoff instead.
          if (state === 'stopped') return;
          state = 'idle';
          startPromise = undefined;
          options.logger.error({ error }, '[FeishuRuntime] Reconnect attempt failed');
          scheduleReconnect('reconnect attempt failed');
        });
    }, reconnectDelayMs);
  };

  return {
    outbound,
    start() {
      if (state === 'stopped') return Promise.reject(new Error('Feishu connector runtime has been stopped'));
      if (startPromise !== undefined) return startPromise;
      state = 'starting';
      startPromise = startIngress()
        .then(() => {
          if (state !== 'stopped') {
            state = 'running';
            options.logger.info('[FeishuRuntime] Provider ingress started');
          }
        })
        .catch((error: unknown) => {
          // stop() aborts the in-flight start on purpose — that is not a start
          // failure and must not surface as an unhandled rejection.
          if (state === 'stopped') return;
          state = 'idle';
          startPromise = undefined;
          throw error;
        });
      return startPromise;
    },
    stop() {
      if (stopPromise !== undefined) return stopPromise;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      if (state === 'idle') { state = 'stopped'; return Promise.resolve(); }
      state = 'stopped';
      wsClient?.close({ force: true });
      wsClient = undefined;
      stopPromise = Promise.resolve();
      return stopPromise;
    },
    async handleWebhook(candidate) {
      if (state === 'stopped') throw new Error('Feishu connector runtime has been stopped');
      if (options.config.connectionMode === 'websocket') return { kind: 'skipped', reason: 'websocket_mode' };
      const { body } = requireFeishuWebhookInput(candidate);
      const challenge = outbound.isVerificationChallenge(body);
      if (challenge !== null) return { kind: 'challenge', response: challenge };
      if (!outbound.verifyEventToken(body)) return { kind: 'error', status: 403, message: 'Invalid verification token' };
      // Events arriving before start() completed (state idle/starting) are not
      // delivered; report them honestly instead of dropping silently and
      // claiming they were processed.
      if (state !== 'running') return { kind: 'skipped', reason: 'not_running' };
      const action = outbound.parseCardAction(body);
      if (action !== null) {
        const routed = await routeCard(action);
        if (routed === 'delivered') return { kind: 'processed', messageId: 'card-action' };
        // 'not_running' covers the guard killing the route mid-flight; only a
        // completed route with an unresolvable chat type is chat_type_unknown.
        return { kind: 'skipped', reason: routed === 'not_running' ? 'not_running' : 'chat_type_unknown' };
      }
      const parsed = outbound.parseEvent(body);
      if (parsed === null) return { kind: 'skipped', reason: 'unsupported_event' };
      return await routeEvent(parsed)
        ? { kind: 'processed', messageId: parsed.messageId }
        : { kind: 'skipped', reason: 'not_running' };
    },
  };
}

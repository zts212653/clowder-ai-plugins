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
 *   before anything is connected), or aborts on stop/timeout.
 *
 * `autoReconnect: false` is deliberate: SDK-owned reconnection was the F2
 * revival mechanism. Reconnect supervision belongs to the Host lifecycle.
 */
export class PausableLarkWsClient implements FeishuWsClient {
  private readonly inner: LarkWsInternals;
  private stopped = false;

  constructor(appId: string, appSecret: string, inner?: LarkWsInternals) {
    this.inner = inner ?? new lark.WSClient({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.info,
      autoReconnect: false,
    }) as unknown as LarkWsInternals;
  }

  async start(options: { eventDispatcher: lark.EventDispatcher }): Promise<void> {
    await this.inner.start(options);
    const deadline = Date.now() + WS_START_TIMEOUT_MS;
    for (;;) {
      if (this.stopped) throw new Error('Feishu WSClient stopped during connect');
      if (this.inner.wsConfig.getWSInstance() !== null) return;
      if (Date.now() >= deadline) {
        throw new Error(`Feishu WSClient start timed out after ${WS_START_TIMEOUT_MS}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, WS_CONNECT_POLL_MS));
    }
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
  readonly createWsClient?: (config: Readonly<{ appId: string; appSecret: string }>) => FeishuWsClient;
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

  const routeEvent = async (message: FeishuInboundMessage) => {
    if (state !== 'running') return;
    const hostMessage = await providerMessage(outbound, message);
    // Group chats await name-resolution round-trips above; stop() landing in
    // that window must not still deliver (TOCTOU recheck after the await).
    if (state !== 'running') return;
    await options.host.deliver(hostMessage);
  };
  const routeCard = async (action: FeishuCardAction) => {
    if (state !== 'running') return false;
    const message = await cardMessage(outbound, action);
    if (message !== null && state === 'running') await options.host.deliver(message);
    return message !== null;
  };

  return {
    outbound,
    start() {
      if (state === 'stopped') return Promise.reject(new Error('Feishu connector runtime has been stopped'));
      if (startPromise !== undefined) return startPromise;
      state = 'starting';
      startPromise = (async () => {
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
        const createWs = options.createWsClient ?? ((value: Readonly<{ appId: string; appSecret: string }>) => (
          new PausableLarkWsClient(value.appId, value.appSecret)
        ));
        const client = createWs({ appId, appSecret });
        wsClient = client;
        // PausableLarkWsClient.start() settles only once the socket is really
        // open (or stop/timeout aborts it), so no outer timer is needed.
        await client.start({ eventDispatcher: dispatcher });
      })().then(() => {
        if (state !== 'stopped') {
          state = 'running';
          options.logger.info('[FeishuRuntime] Provider ingress started');
        }
      }).catch((error: unknown) => {
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
      if (state === 'idle') { state = 'stopped'; return Promise.resolve(); }
      state = 'stopped';
      wsClient?.close({ force: true });
      wsClient = undefined;
      stopPromise = Promise.resolve();
      return stopPromise;
    },    async handleWebhook(candidate) {
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
        return await routeCard(action)
          ? { kind: 'processed', messageId: 'card-action' }
          : { kind: 'skipped', reason: 'chat_type_unknown' };
      }
      const parsed = outbound.parseEvent(body);
      if (parsed === null) return { kind: 'skipped', reason: 'unsupported_event' };
      await routeEvent(parsed);
      return { kind: 'processed', messageId: parsed.messageId };
    },
  };
}

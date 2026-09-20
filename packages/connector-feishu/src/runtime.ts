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

  const routeEvent = async (message: FeishuInboundMessage) => options.host.deliver(await providerMessage(outbound, message));
  const routeCard = async (action: FeishuCardAction) => {
    const message = await cardMessage(outbound, action);
    if (message !== null) await options.host.deliver(message);
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
          new lark.WSClient({ ...value, loggerLevel: lark.LoggerLevel.info })
        ));
        wsClient = createWs({ appId, appSecret });
        await wsClient.start({ eventDispatcher: dispatcher });
      })().then(() => {
        if (state !== 'stopped') {
          state = 'running';
          options.logger.info('[FeishuRuntime] Provider ingress started');
        }
      }).catch((error: unknown) => {
        if (state !== 'stopped') { state = 'idle'; startPromise = undefined; }
        throw error;
      });
      return startPromise;
    },
    stop() {
      if (stopPromise !== undefined) return stopPromise;
      if (state === 'idle') { state = 'stopped'; return Promise.resolve(); }
      state = 'stopped';
      stopPromise = (async () => {
        await startPromise?.catch(() => undefined);
        wsClient?.close({ force: true });
        wsClient = undefined;
      })();
      return stopPromise;
    },
    async handleWebhook(candidate) {
      if (state === 'stopped') throw new Error('Feishu connector runtime has been stopped');
      if (options.config.connectionMode === 'websocket') return { kind: 'skipped', reason: 'websocket_mode' };
      const { body } = requireFeishuWebhookInput(candidate);
      const challenge = outbound.isVerificationChallenge(body);
      if (challenge !== null) return { kind: 'challenge', response: challenge };
      if (!outbound.verifyEventToken(body)) return { kind: 'error', status: 403, message: 'Invalid verification token' };
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

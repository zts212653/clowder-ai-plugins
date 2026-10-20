import {
  WeComAgentAdapter,
  type WeComAgentAdapterOptions,
  type WeComAgentInboundMessage,
} from './WeComAgentAdapter.js';
import type { ConnectorLogger } from './types.js';

export interface WeComAgentRuntimeConfig {
  readonly corpId: string;
  readonly agentId: string;
  readonly agentSecret: string;
  readonly callbackToken: string;
  readonly encodingAesKey: string;
}

export interface WeComAgentWebhookInput {
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string>>;
}

export type WeComAgentWebhookResult =
  | Readonly<{ kind: 'challenge'; response: string }>
  | Readonly<{ kind: 'processed'; messageId: string }>
  | Readonly<{ kind: 'skipped'; reason: string }>
  | Readonly<{ kind: 'error'; status: number; message: string }>;

export interface WeComAgentHostInboundMessage {
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

export interface WeComAgentRuntimeHost {
  deliver(message: WeComAgentHostInboundMessage): Promise<void>;
}

export interface WeComAgentRuntimeAdapter {
  readonly connectorId: string;
  verifyCallback: WeComAgentAdapter['verifyCallback'];
  decryptInbound: WeComAgentAdapter['decryptInbound'];
  parseEvent: WeComAgentAdapter['parseEvent'];
  sendFormattedReply: WeComAgentAdapter['sendFormattedReply'];
  sendMedia: WeComAgentAdapter['sendMedia'];
  sendReply: WeComAgentAdapter['sendReply'];
}

export interface WeComAgentConnectorRuntime<Adapter extends WeComAgentRuntimeAdapter = WeComAgentAdapter> {
  readonly outbound: Adapter;
  start(): Promise<void>;
  stop(): Promise<void>;
  handleWebhook(input: WeComAgentWebhookInput): Promise<WeComAgentWebhookResult>;
}

export interface WeComAgentConnectorRuntimeOptions<Adapter extends WeComAgentRuntimeAdapter = WeComAgentAdapter> {
  readonly config: WeComAgentRuntimeConfig;
  readonly host: WeComAgentRuntimeHost;
  readonly logger: ConnectorLogger;
  readonly createAdapter?: (logger: ConnectorLogger, config: WeComAgentAdapterOptions) => Adapter;
}

function required(value: string, key: keyof WeComAgentRuntimeConfig): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${key} must be a non-empty declared value`);
  return normalized;
}

function hostMessage(message: WeComAgentInboundMessage): WeComAgentHostInboundMessage {
  const attachments = message.attachments?.map((attachment) => ({
    type: attachment.type === 'video' ? 'file' as const : attachment.type,
    platformKey: attachment.mediaId,
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

export function requireWeComAgentWebhookInput(candidate: unknown): WeComAgentWebhookInput {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('wecom-agent webhook input must be an object');
  }
  const input = candidate as Record<string, unknown>;
  if (input.query !== undefined && (
    input.query === null || typeof input.query !== 'object' || Array.isArray(input.query)
    || Object.values(input.query).some(value => typeof value !== 'string')
  )) {
    throw new TypeError('wecom-agent webhook query must contain string values');
  }
  return { body: input.body, ...(input.query === undefined ? {} : { query: input.query as Record<string, string> }) };
}

export function createWeComAgentConnectorRuntime<Adapter extends WeComAgentRuntimeAdapter = WeComAgentAdapter>(
  options: WeComAgentConnectorRuntimeOptions<Adapter>,
): WeComAgentConnectorRuntime<Adapter> {
  const config: WeComAgentAdapterOptions = {
    corpId: required(options.config.corpId, 'corpId'),
    agentId: required(options.config.agentId, 'agentId'),
    agentSecret: required(options.config.agentSecret, 'agentSecret'),
    token: required(options.config.callbackToken, 'callbackToken'),
    encodingAesKey: required(options.config.encodingAesKey, 'encodingAesKey'),
  };
  const createAdapter = options.createAdapter ?? ((logger: ConnectorLogger, value: WeComAgentAdapterOptions) => (
    new WeComAgentAdapter(logger, value) as unknown as Adapter
  ));
  const outbound = createAdapter(options.logger, config);
  let stopped = false;

  return {
    outbound,
    async start() {
      if (stopped) throw new Error('WeCom Agent connector runtime has been stopped');
    },
    async stop() { stopped = true; },
    async handleWebhook(candidate) {
      if (stopped) throw new Error('WeCom Agent connector runtime has been stopped');
      const input = requireWeComAgentWebhookInput(candidate);
      const query = input.query ?? {};
      const signature = query.msg_signature ?? '';
      const timestamp = query.timestamp ?? '';
      const nonce = query.nonce ?? '';
      if (query.echostr !== undefined) {
        const response = outbound.verifyCallback({ msg_signature: signature, timestamp, nonce, echostr: query.echostr });
        return response === null
          ? { kind: 'error', status: 403, message: 'echostr verification failed' }
          : { kind: 'challenge', response };
      }
      const body = typeof input.body === 'string'
        ? input.body
        : input.body === undefined
          ? undefined
          : JSON.stringify(input.body);
      if (body === undefined) throw new TypeError('wecom-agent webhook body must be XML text');
      const decrypted = outbound.decryptInbound(body, { msg_signature: signature, timestamp, nonce });
      if (decrypted === null) {
        return { kind: 'error', status: 403, message: 'Signature verification or decryption failed' };
      }
      const parsed = outbound.parseEvent(decrypted);
      if (parsed === null) return { kind: 'skipped', reason: 'unsupported_event' };
      await options.host.deliver(hostMessage(parsed));
      return { kind: 'processed', messageId: parsed.messageId };
    },
  };
}

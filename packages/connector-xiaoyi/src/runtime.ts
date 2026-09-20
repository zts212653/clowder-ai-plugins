import { XiaoyiAdapter } from './XiaoyiAdapter.js';
import type { XiaoyiAdapterOptions, XiaoyiInboundMessage } from './xiaoyi-protocol.js';
import type { ConnectorLogger } from './types.js';

export interface XiaoyiRuntimeConfig {
  readonly accessKey: string;
  readonly secretKey: string;
  readonly agentId: string;
}

export interface XiaoyiHostInboundMessage {
  readonly externalConversationId: string;
  readonly externalSenderId: string;
  readonly providerMessageId: string;
  readonly text: string;
}

export interface XiaoyiRuntimeHost {
  deliver(message: XiaoyiHostInboundMessage): Promise<void>;
}

export interface XiaoyiRuntimeAdapter {
  readonly connectorId: string;
  startStream(handler: (message: XiaoyiInboundMessage) => Promise<void>): Promise<void>;
  stopStream(): Promise<void>;
  sendReply: XiaoyiAdapter['sendReply'];
  onDeliveryBatchDone: XiaoyiAdapter['onDeliveryBatchDone'];
}

export interface XiaoyiConnectorRuntime<Adapter extends XiaoyiRuntimeAdapter = XiaoyiAdapter> {
  readonly outbound: Adapter;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface XiaoyiConnectorRuntimeOptions<Adapter extends XiaoyiRuntimeAdapter = XiaoyiAdapter> {
  readonly config: XiaoyiRuntimeConfig;
  readonly host: XiaoyiRuntimeHost;
  readonly logger: ConnectorLogger;
  readonly createAdapter?: (logger: ConnectorLogger, config: XiaoyiAdapterOptions) => Adapter;
}

function required(value: string, key: keyof XiaoyiRuntimeConfig): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${key} must be a non-empty declared value`);
  return normalized;
}

function hostMessage(message: XiaoyiInboundMessage): XiaoyiHostInboundMessage {
  return {
    externalConversationId: message.chatId,
    externalSenderId: message.senderId,
    providerMessageId: message.messageId,
    text: message.text,
  };
}

export function createXiaoyiConnectorRuntime<Adapter extends XiaoyiRuntimeAdapter = XiaoyiAdapter>(
  options: XiaoyiConnectorRuntimeOptions<Adapter>,
): XiaoyiConnectorRuntime<Adapter> {
  const config: XiaoyiAdapterOptions = {
    ak: required(options.config.accessKey, 'accessKey'),
    sk: required(options.config.secretKey, 'secretKey'),
    agentId: required(options.config.agentId, 'agentId'),
  };
  const createAdapter = options.createAdapter ?? ((logger: ConnectorLogger, value: XiaoyiAdapterOptions) => (
    new XiaoyiAdapter(logger, value) as unknown as Adapter
  ));
  const outbound = createAdapter(options.logger, config);
  let state: 'idle' | 'starting' | 'running' | 'stopped' = 'idle';
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  return {
    outbound,
    start() {
      if (state === 'stopped') return Promise.reject(new Error('XiaoYi connector runtime has been stopped'));
      if (startPromise !== undefined) return startPromise;
      state = 'starting';
      startPromise = outbound.startStream(async message => options.host.deliver(hostMessage(message)))
        .then(() => {
          if (state !== 'stopped') {
            state = 'running';
            options.logger.info('[XiaoyiRuntime] Provider stream started');
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

import {
  definePlugin,
  definePluginModule,
  requireConnectorOutboundDelivery,
  type ConnectorOutboundDelivery,
  type FeatureContext,
  type PluginMessagingDelivery,
  type PluginMessagingDraft,
} from '@clowder-ai/plugin-sdk';

import { FeishuAdapter } from './FeishuAdapter.js';
import { DefaultFeishuQrBindClient, type FeishuQrBindClient } from './FeishuQrBindClient.js';
import { renderTypedMediaNotice } from './media-notice.js';
import { createInboundMediaSourceActions, releaseInboundMedia, retainInboundMedia } from './inbound-media-source.js';
import { createConnectorLifecycleAction } from './lifecycle-action.js';
import { createReplySenderMap } from './reply-sender-map.js';
import {
  createFeishuConnectorRuntime,
  requireFeishuWebhookInput,
  type FeishuConnectorRuntime,
  type FeishuConnectorRuntimeOptions,
  type FeishuHostInboundMessage,
  type FeishuWebhookResult,
} from './runtime.js';

type RuntimeFactory = (
  options: FeishuConnectorRuntimeOptions<FeishuAdapter>,
) => FeishuConnectorRuntime<FeishuAdapter>;

const CONNECTOR_ID = 'feishu';
const IDENTITY_ID = 'feishu-bot';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireDelivery(candidate: unknown): PluginMessagingDelivery {
  if (!object(candidate)) throw new TypeError('feishu delivery must be an object');
  if (Object.keys(candidate).some(key => !['deliveryId', 'lifecycleId', 'threadId', 'envelope', 'presentation'].includes(key))) {
    throw new TypeError('feishu delivery contains an unsupported field');
  }
  if (typeof candidate.deliveryId !== 'string' || candidate.deliveryId.length === 0) {
    throw new TypeError('feishu deliveryId must be non-empty');
  }
  if (typeof candidate.threadId !== 'string' || candidate.threadId.length === 0) {
    throw new TypeError('feishu threadId must be non-empty');
  }
  if (!object(candidate.envelope) || candidate.envelope.threadId !== candidate.threadId) {
    throw new TypeError('feishu delivery envelope must match threadId');
  }
  return structuredClone(candidate) as unknown as PluginMessagingDelivery;
}

function threadTitle(message: FeishuHostInboundMessage): string {
  const value = message.conversation.title?.trim() || `Feishu ${message.externalConversationId}`;
  return value.length <= 200 ? value : value.slice(0, 200);
}

async function draft(context: FeatureContext, message: FeishuHostInboundMessage) {
  const retained = await retainInboundMedia(
    context, CONNECTOR_ID, 'feishu-media', message.providerMessageId,
    (message.attachments ?? []).map(attachment => ({
      type: attachment.type, platformKey: attachment.platformKey,
      ...(attachment.fileName === undefined ? {} : { fileName: attachment.fileName }),
      ...(attachment.duration === undefined ? {} : { duration: attachment.duration }),
    })),
  );
  const messageDraft: PluginMessagingDraft = {
    idempotencyKey: message.providerMessageId,
    sourceEventId: message.providerMessageId,
    identity: IDENTITY_ID,
    ...(message.sender === undefined ? {} : { sender: message.sender }),
    payload: {
      provenance: {
        origin: {
          kind: 'external', connectorId: CONNECTOR_ID,
          sourceAddress: { connectorId: CONNECTOR_ID, chatId: message.externalConversationId, messageId: message.providerMessageId },
        },
        epistemicStatus: 'observation',
      },
      elements: [
        { elementId: 'text-1', kind: 'text', payload: { text: message.text } },
        ...retained.elements,
      ],
    },
  };
  return { messageDraft, ownership: retained.ownership };
}

async function createMessageBridge(context: FeatureContext) {
  const replySenders = createReplySenderMap(context);
  const subscriptions = new Map<string, Promise<void>>();
  const subscribe = (threadId: string): Promise<void> => {
    const current = subscriptions.get(threadId);
    if (current !== undefined) return current;
    let pending!: Promise<void>;
    pending = context.messaging.subscribe(threadId, { contributionId: CONNECTOR_ID }).catch((error: unknown) => {
      if (subscriptions.get(threadId) === pending) subscriptions.delete(threadId);
      throw error;
    });
    subscriptions.set(threadId, pending);
    return pending;
  };
  for (const binding of await context.threads.listBindings()) await subscribe(binding.threadId);
  return {
    async deliver(message: FeishuHostInboundMessage): Promise<void> {
      const thread = await context.threads.ensureByKey(message.externalConversationId, { title: threadTitle(message) });
      await subscribe(thread.id);
      const prepared = await draft(context, message);
      try {
        const sent = await context.messaging.send(thread.id, prepared.messageDraft);
        if (prepared.messageDraft.sender !== undefined) {
          try {
            await replySenders.record(sent.messageId, prepared.messageDraft.sender);
          } catch (error) {
            context.log('warn', 'Feishu reply-sender mapping record failed', {
              errorName: error instanceof Error ? error.name : 'unknown',
            });
          }
        }
      } catch (error) {
        await releaseInboundMedia(context, prepared.ownership, error);
        throw error;
      }
    },
    async outbound(candidate: unknown) {
      const input = requireDelivery(candidate);
      const bindings = (await context.threads.listBindings()).filter(item => item.threadId === input.threadId);
      if (bindings.length === 0) throw new TypeError(`feishu thread ${input.threadId} has no provider binding`);
      const text = input.envelope.payload.elements.flatMap((element) => {
        if (element.kind === 'text') return [element.payload.text];
        const notice = renderTypedMediaNotice(element, {
          elements: input.envelope.payload.elements,
          warnInvalid: elementId => context.log('warn', 'Invalid typed media notice ignored', { elementId }),
        });
        return notice === undefined ? [] : [notice];
      }).join('\n\n');
      const richBlocks = input.envelope.payload.elements.filter(element => element.kind === 'rich_block').map(element => element.payload);
      const media = input.envelope.payload.elements.flatMap((element) => {
        if (element.kind !== 'media_ref' || !object(element.payload)) return [];
        const type = element.payload.type;
        const reference = element.payload.reference;
        if (!['image', 'file', 'audio', 'video'].includes(String(type)) || typeof reference !== 'string') return [];
        return [{ type, reference, ...(typeof element.payload.fileName === 'string' ? { fileName: element.payload.fileName } : {}) }];
      });
      const displayName = input.presentation?.actor.displayName || input.envelope.actor.id;
      const replyPrefix = input.envelope.actor.kind === 'cat' ? `【${displayName}🐱】\n` : '';
      const replyToSender = await replySenders.resolve(input.envelope.replyTo);
      // One thread can carry several provider bindings (the Host allows
      // rebinding different external chats onto the same thread), so the
      // same Host delivery fans out to every binding.
      return {
        replyPrefix,
        inputs: bindings.map(binding => requireConnectorOutboundDelivery({
          deliveryId: input.deliveryId,
          externalConversationId: binding.key,
          presentation: { header: displayName, body: text, origin: input.envelope.actor.kind === 'cat' ? 'agent' : input.envelope.actor.kind === 'system' ? 'system' : 'direct' },
          ...(replyToSender === undefined ? {} : { metadata: { replyToSender } }),
          ...(richBlocks.length === 0 ? {} : { richBlocks }),
          ...(media.length === 0 ? {} : { media }),
        })),
      };
    },
  };
}

function optionalString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`${key} must be a declared string`);
  return value;
}

function forwardedWebhookBody(candidate: unknown): unknown {
  if (!object(candidate) || !object(candidate.request)) {
    throw new TypeError('feishu webhook action requires a forwarded request');
  }
  if (Object.keys(candidate).some(key => key !== 'request')) {
    throw new TypeError('feishu webhook action contains an unsupported field');
  }
  const request = candidate.request;
  if (request.method !== 'POST' || request.path !== 'feishu/events') {
    throw new TypeError('feishu webhook request must match the declared POST path');
  }
  return requireFeishuWebhookInput({ body: request.body }).body;
}

function webhookHttpResponse(result: FeishuWebhookResult) {
  switch (result.kind) {
    case 'challenge': return { status: 200, headers: {}, body: result.response };
    case 'processed': return { status: 200, headers: {}, body: { ok: true, messageId: result.messageId } };
    case 'skipped': return { status: 200, headers: {}, body: { ok: true, skipped: result.reason } };
    case 'error': return { status: result.status, headers: {}, body: { error: result.message } };
    default: throw new TypeError('feishu webhook runtime returned an invalid result');
  }
}

async function deliverOutbound(
  outbound: FeishuAdapter,
  input: ConnectorOutboundDelivery,
  context: FeatureContext,
  replyPrefix: string,
): Promise<void> {
  const blocks = [...(input.richBlocks ?? [])];
  if (blocks.length > 0) {
    await outbound.sendRichMessage(
      input.externalConversationId,
      input.presentation.body,
      blocks as unknown as Parameters<FeishuAdapter['sendRichMessage']>[2],
      input.presentation.header,
      input.metadata,
    );
  } else {
    await outbound.sendFormattedReply(input.externalConversationId, {
      header: input.presentation.header,
      subtitle: input.presentation.subtitle ?? '',
      body: input.presentation.body,
      footer: input.presentation.footer ?? '',
      origin: input.presentation.origin === 'callback' ? 'callback' : 'agent',
      ...(input.presentation.cardActions === undefined
        ? {} : { cardActions: input.presentation.cardActions.map(action => ({ label: action.label, value: { ...action.value } })) }),
    }, input.metadata);
  }
  for (const media of input.media ?? []) {
    if (media.type === 'video') {
      await outbound.sendReply(input.externalConversationId, `${replyPrefix}⚠️ 视频附件暂不支持发送`, input.metadata);
      continue;
    }
    if (!media.reference.startsWith('hmr_')) {
      await outbound.sendReply(input.externalConversationId, `${replyPrefix}⚠️ 媒体不可用（旧引用无法读取）`, input.metadata);
      continue;
    }
    try {
      await outbound.sendMedia(input.externalConversationId, {
        type: media.type,
        content: context.media.read(media.reference),
        ...(media.fileName === undefined ? {} : { fileName: media.fileName }),
      });
    } catch (error) {
      context.log('warn', 'Feishu outbound media delivery failed', {
        mediaType: media.type,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      await outbound.sendReply(
        input.externalConversationId,
        `${replyPrefix}${error instanceof RangeError ? '⚠️ 媒体过大，超过飞书发送上限' : '⚠️ 媒体不可用（读取或上传失败）'}`,
        input.metadata,
      );
    }
  }
}

export function createFeishuPluginModule(
  createRuntime: RuntimeFactory = createFeishuConnectorRuntime,
  createQrClient: () => FeishuQrBindClient = () => new DefaultFeishuQrBindClient(),
) {
  return definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'feishu-messaging': async (context) => {
        const [appId, appSecret, modeValue, verificationToken, groupBotMentionsJson] = await Promise.all([
          context.config.get('appId'),
          context.secrets.get('appSecret'),
          context.config.get('connectionMode'),
          context.secrets.get('verificationToken'),
          context.config.get('groupBotMentionsJson'),
        ]);
        // Credentials may arrive only later via the feishu_qr_login operation —
        // the runtime starts healthy and idle (no ingress) without them.
        const mode = modeValue === undefined ? 'webhook' : modeValue;
        if (mode !== 'webhook' && mode !== 'websocket') throw new TypeError('connectionMode must be webhook or websocket');
        const bridge = await createMessageBridge(context);
        const runtime = createRuntime({
          config: {
            appId: typeof appId === 'string' ? appId : '',
            appSecret: typeof appSecret === 'string' ? appSecret : '',
            connectionMode: mode,
            ...(verificationToken === '' ? {} : { verificationToken }),
            ...(optionalString(groupBotMentionsJson, 'groupBotMentionsJson') === undefined
              ? {} : { groupBotMentionsJson: groupBotMentionsJson as string }),
          },
          host: { deliver: bridge.deliver },
          logger: context.logger,
        });
        await runtime.start();
        const mediaSource = createInboundMediaSourceActions(context, locator => runtime.outbound.downloadInboundMedia(locator));
        const lifecycleReplySenders = createReplySenderMap(context);
        const lifecycle = createConnectorLifecycleAction(context, {
          sendPlaceholder: (externalConversationId, text) => runtime.outbound.sendPlaceholder(externalConversationId, text),
          editPlaceholder: (externalConversationId, platformMessageId, text) => runtime.outbound.editMessage(externalConversationId, platformMessageId, text),
          sendRecovery: (externalConversationId, text) => runtime.outbound.sendReply(externalConversationId, text),
          resolveReplySenderName: async (replyTo) => {
            const sender = await lifecycleReplySenders.resolve(replyTo);
            return sender?.name;
          },
          settle: async ({ externalConversationId, platformMessageId, actorDisplayName, recoveryText, event }) => {
            if (platformMessageId !== undefined && recoveryText === undefined) {
              await runtime.outbound.finalizeStreamCard(
                externalConversationId,
                platformMessageId,
                actorDisplayName,
                event.outcome,
              );
            }
          },
        });
        // Operation state (the in-flight device_code) lives in runtime memory only.
        let qrPayload: string | undefined;
        const qrClient = createQrClient();
        return {
          actions: {
            'host.messaging.lifecycle': lifecycle,
            'feishu.media-source.read': mediaSource.read,
            'feishu.media-source.settle': mediaSource.settle,
            'feishu.qr-generate': async () => {
              const result = await qrClient.create();
              qrPayload = result.qrPayload;
              // The QR client already encodes the verification page as a PNG data URL.
              return { render: 'img', data: { url: result.qrUrl } };
            },
            'feishu.qr-status': async () => {
              if (qrPayload === undefined) {
                return { render: 'polling', data: { status: 'error', message: 'No QR payload — generate first' }, advance: false };
              }
              const status = await qrClient.poll(qrPayload);
              if (status.status === 'confirmed') {
                if (status.appId === undefined || status.appSecret === undefined) {
                  return { render: 'polling', data: { status: 'error', message: 'confirmed but no credentials' }, advance: false };
                }
                // QR-based login targets WebSocket mode (works without a public URL).
                await runtime.connect({ appId: status.appId, appSecret: status.appSecret, connectionMode: 'websocket' });
                qrPayload = undefined;
                return {
                  render: 'status',
                  data: { status: 'confirmed' },
                  label: '已授权',
                  targetValues: {
                    appId: status.appId,
                    appSecret: status.appSecret,
                    connectionMode: 'websocket',
                  },
                };
              }
              if (status.status === 'waiting') {
                return { render: 'polling', data: { status: 'waiting' }, advance: false };
              }
              return {
                render: 'polling',
                data: { status: status.status, ...(status.error === undefined ? {} : { message: status.error }) },
                advance: false,
              };
            },
            'feishu.disconnect': async () => {
              qrPayload = undefined;
              await runtime.disconnect();
              return {
                render: 'status',
                data: { status: 'disconnected' },
                label: '已断开',
                targetValues: { appId: '', appSecret: '' },
              };
            },
            'feishu.test': async () => {
              // Readiness comes from the live runtime only: the activation-time
              // config/secrets snapshot goes stale once qr-status adopts QR
              // credentials in-process (the Host write-back does not restart
              // the plugin), so reading it here would report ok:false for a
              // connection that is actually live.
              const status = runtime.status();
              const ok = status.connectionMode === 'websocket'
                ? status.connected
                : status.connected && status.hasVerificationToken;
              return { ok, ...(ok ? {} : { message: '飞书未配置或凭据无效' }) };
            },
            'feishu.outbound': async (candidate) => {
              const { inputs, replyPrefix } = await bridge.outbound(candidate);
              // Per-binding isolation: one thread can fan out to several
              // provider bindings, and a failure on one chat must not block
              // or fail the others. A single binding keeps the old fail-fast
              // behavior so the Host redelivers; with several bindings the
              // action only rejects when every binding failed.
              let firstFailure: unknown;
              let delivered = 0;
              for (const input of inputs) {
                try {
                  await deliverOutbound(runtime.outbound, input, context, replyPrefix);
                  delivered += 1;
                } catch (error) {
                  if (firstFailure === undefined) firstFailure = error;
                  context.log('warn', 'Feishu outbound delivery to one binding failed', {
                    externalConversationId: input.externalConversationId,
                    errorName: error instanceof Error ? error.name : 'unknown',
                  });
                }
              }
              if (delivered === 0) {
                if (firstFailure !== undefined) throw firstFailure;
                throw new Error(
                  'Feishu outbound delivery failed for all bindings (provider did not report an error)',
                );
              }
            },
            'feishu.webhook': async candidate => webhookHttpResponse(
              await runtime.handleWebhook({ body: forwardedWebhookBody(candidate) }),
            ),
          },
          dispose: () => runtime.stop(),
        };
      },
    },
  }));
}

export default createFeishuPluginModule();

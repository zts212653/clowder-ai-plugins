import {isPluginDeliveryInput} from '@clowder-ai/plugin-contract';
import { definePluginModule } from '@clowder-ai/plugin-sdk';
import { threadMappings } from './thread-mappings.js';
import { createFeishuSettings, type SettingsEntrypoint } from './settings.js';
import {createConnectorCommandBridge} from '@clowder-ai/plugin-sdk';
import {
  definePlugin,
  defineDeliveryAction,
  requireConnectorOutboundDelivery,
  type ConnectorOutboundDelivery,
  type FeatureContext,
  type PluginMessagingDelivery,
  type PluginMessagingDraft,
} from '@clowder-ai/plugin-sdk';

import { FeishuAdapter } from './FeishuAdapter.js';
import { DefaultFeishuQrBindClient, type FeishuQrBindClient } from './FeishuQrBindClient.js';
import { renderTypedMediaNotice } from './media-notice.js';
import { createInboundMediaSource, releaseInboundMedia, retainInboundMedia } from './inbound-media-source.js';
import { createConnectorLifecycleAction } from './lifecycle-action.js';
import { createReplySenderMap } from './reply-sender-map.js';
import { connectorCommandFacts } from './command-ingress.js';
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
  if(!isPluginDeliveryInput(candidate)||candidate.kind!=='message')throw new TypeError('feishu requires a message delivery');
  return structuredClone(candidate);
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

async function createMessageBridge(context: FeatureContext, reply: (input: { readonly chatId: string; readonly group: boolean; readonly senderId?: string | undefined }, response: string, cardActions?: readonly { label: string; value: { cmd: string; args?: string } }[]) => Promise<void>) {
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
  for (const binding of await threadMappings(context).listBindings()) await subscribe(binding.threadId);
  const routeCommand = createConnectorCommandBridge(context, {
    connectorId: CONNECTOR_ID, identityId: IDENTITY_ID,
    reply: (input, result) => reply(input, result.response, result.cardActions),
    settle: async () => {},
    async bindingChanged(change) {
      if (change.threadId !== undefined) await subscribe(change.threadId);
      if (change.previousThreadId !== undefined && change.previousThreadId !== change.threadId &&
          !(await threadMappings(context).listBindings()).some(binding => binding.threadId === change.previousThreadId)) {
        await context.messaging.unsubscribe(change.previousThreadId);
        subscriptions.delete(change.previousThreadId);
      }
    },
  });
  return {
    async deliver(message: FeishuHostInboundMessage): Promise<void> {
      await routeCommand(connectorCommandFacts(message), async () => {
        const thread = await threadMappings(context).ensureByKey(message.externalConversationId, { title: threadTitle(message) });
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
      });
    },
    async outbound(candidate: unknown) {
      const input = requireDelivery(candidate);
      const bindings = (await threadMappings(context).listBindings()).filter(item => item.threadId === input.threadId);
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
        content: context.streams.read(media.reference),
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
): SettingsEntrypoint {
  const runtimeModule = definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'feishu-messaging': async (context) => {
        let runtime!: FeishuConnectorRuntime<FeishuAdapter>;
        const bridge = await createMessageBridge(context, (input, body, cardActions) => runtime.outbound.sendFormattedReply(input.chatId, {
          header: 'Clowder AI', subtitle: '', body, footer: '', origin: 'callback',
          ...(cardActions === undefined ? {} : { cardActions: cardActions.map(action => ({ label: action.label, value: { ...action.value } })) }),
        }, input.group && input.senderId !== undefined ? { replyToSender: { id: input.senderId } } : undefined));
        const configure = async () => {
          await runtime?.stop();

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
        runtime = createRuntime({
          config: {
            appId: typeof appId === 'string' ? appId : '',
            appSecret: typeof appSecret === 'string' ? appSecret : '',
            connectionMode: mode,
            ...(verificationToken === '' ? {} : { verificationToken }),
            ...(optionalString(groupBotMentionsJson, 'groupBotMentionsJson') === undefined
              ? {} : { groupBotMentionsJson: groupBotMentionsJson as string }),
          },
          host: { deliver: bridge.deliver },
          logger: {debug: (...args: unknown[]) => context.log('debug', String(args[0]), {args}),info: (...args: unknown[]) => context.log('info', String(args[0]), {args}),warn: (...args: unknown[]) => context.log('warn', String(args[0]), {args}),error: (...args: unknown[]) => context.log('error', String(args[0]), {args})},
        });
        await runtime.start();
        };
        await configure();
        const mediaSource = createInboundMediaSource(context, locator => runtime.outbound.downloadInboundMedia(locator));
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
        const qrClient = createQrClient();
        return {
          configRefresh: configure,
          streams: mediaSource,
          actions: {
            ...createFeishuSettings(context, createQrClient()).actions,


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
            'feishu.outbound': defineDeliveryAction(async (candidate) => {
              if(candidate.kind==='execution_status'){return lifecycle(candidate);}

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

              return {deliveryId:candidate.deliveryId};
            }),
            'feishu.webhook': async candidate => webhookHttpResponse(
              await runtime.handleWebhook({ body: forwardedWebhookBody(candidate) }),
            ),
          },
          dispose: () => runtime.stop(),
        };
      },
    },
  }));
  return {
    create(manifest) {
      return { ...runtimeModule.create(manifest), settings: host => createFeishuSettings(host, createQrClient()) };
    },
  };
}

export default createFeishuPluginModule();

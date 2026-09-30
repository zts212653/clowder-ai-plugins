import {
  definePlugin,
  definePluginModule,
  requireConnectorOutboundDelivery,
  type ConnectorOutboundDelivery,
  type FeatureContext,
  type PluginMessagingDelivery,
  type PluginMessagingDraft,
} from '@clowder-ai/plugin-sdk';

import { WeComBotAdapter } from './WeComBotAdapter.js';
import { renderTypedMediaNotice } from './media-notice.js';
import { createInboundMediaSourceActions, releaseInboundMedia, retainInboundMedia } from './inbound-media-source.js';
import { createConnectorLifecycleAction } from './lifecycle-action.js';
import { createReplySenderMap } from './reply-sender-map.js';
import {
  createWeComBotConnectorRuntime,
  type WeComBotConnectorRuntime,
  type WeComBotConnectorRuntimeOptions,
  type WeComBotHostInboundMessage,
} from './runtime.js';

type RuntimeFactory = (
  options: WeComBotConnectorRuntimeOptions<WeComBotAdapter>,
) => WeComBotConnectorRuntime<WeComBotAdapter>;

type ValidateCredentialsFn = (
  botId: string,
  secret: string,
) => Promise<{ valid: boolean; error?: string }>;

const CONNECTOR_ID = 'wecom-bot';
const IDENTITY_ID = 'wecom-bot';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireDelivery(candidate: unknown): PluginMessagingDelivery {
  if (!object(candidate)) throw new TypeError('wecom-bot delivery must be an object');
  if (Object.keys(candidate).some(key => !['deliveryId', 'lifecycleId', 'threadId', 'envelope', 'presentation'].includes(key))) throw new TypeError('wecom-bot delivery contains an unsupported field');
  if (typeof candidate.deliveryId !== 'string' || candidate.deliveryId.length === 0) throw new TypeError('wecom-bot deliveryId must be non-empty');
  if (typeof candidate.threadId !== 'string' || candidate.threadId.length === 0) throw new TypeError('wecom-bot threadId must be non-empty');
  if (!object(candidate.envelope) || candidate.envelope.threadId !== candidate.threadId) throw new TypeError('wecom-bot delivery envelope must match threadId');
  return structuredClone(candidate) as unknown as PluginMessagingDelivery;
}

async function draft(context: FeatureContext, message: WeComBotHostInboundMessage) {
  const retained = await retainInboundMedia(
    context, CONNECTOR_ID, 'wecom-bot-media', message.providerMessageId,
    (message.attachments ?? []).map(attachment => ({
      type: attachment.type, platformKey: attachment.platformKey,
      ...(attachment.fileName === undefined ? {} : { fileName: attachment.fileName }),
    })),
  );
  const messageDraft: PluginMessagingDraft = {
    idempotencyKey: message.providerMessageId,
    sourceEventId: message.providerMessageId,
    identity: IDENTITY_ID,
    sender: message.sender,
    payload: {
      provenance: {
        origin: { kind: 'external', connectorId: CONNECTOR_ID, sourceAddress: { connectorId: CONNECTOR_ID, chatId: message.externalConversationId, messageId: message.providerMessageId } },
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
    async deliver(message: WeComBotHostInboundMessage): Promise<void> {
      const thread = await context.threads.ensureByKey(message.externalConversationId, { title: `WeCom ${message.externalConversationId}`.slice(0, 200) });
      await subscribe(thread.id);
      const prepared = await draft(context, message);
      try {
        const sent = await context.messaging.send(thread.id, prepared.messageDraft);
        if (prepared.messageDraft.sender !== undefined) {
          try {
            await replySenders.record(sent.messageId, prepared.messageDraft.sender);
          } catch (error) {
            context.log('warn', 'WeCom bot reply-sender mapping record failed', {
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
      if (bindings.length === 0) throw new TypeError(`wecom-bot thread ${input.threadId} has no provider binding`);
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

async function deliverOutbound(
  outbound: WeComBotAdapter,
  input: ConnectorOutboundDelivery,
  context: FeatureContext,
  replyPrefix: string,
): Promise<void> {
  const blocks = [...(input.richBlocks ?? [])];
  if (blocks.length > 0) {
    await outbound.sendRichMessage(
      input.externalConversationId,
      input.presentation.body,
      blocks as unknown as Parameters<WeComBotAdapter['sendRichMessage']>[2],
      input.presentation.header,
      input.metadata,
    );
  } else {
    await outbound.sendFormattedReply(
      input.externalConversationId,
      {
        header: input.presentation.header,
        body: input.presentation.body,
        origin: input.presentation.origin === 'callback' ? 'callback' : 'direct',
        ...(input.presentation.subtitle === undefined ? {} : { subtitle: input.presentation.subtitle }),
        ...(input.presentation.footer === undefined ? {} : { footer: input.presentation.footer }),
      },
      input.metadata,
    );
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
      context.log('warn', 'WeCom bot outbound media delivery failed', {
        mediaType: media.type,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      await outbound.sendReply(
        input.externalConversationId,
        `${replyPrefix}${error instanceof RangeError || (error instanceof Error && error.name === 'ProviderMediaLimitError')
          ? '⚠️ 媒体过大，超过企业微信发送上限'
          : '⚠️ 媒体不可用（读取或上传失败）'}`,
        input.metadata,
      );
    }
  }
}

export function createWeComBotPluginModule(
  createRuntime: RuntimeFactory = createWeComBotConnectorRuntime,
  validateCredentials: ValidateCredentialsFn = (botId, secret) => WeComBotAdapter.validateCredentials(botId, secret),
) {
  return definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'wecom-bot-messaging': async (context) => {
        // Credentials may be filled only after the plugin is enabled — the runtime
        // starts healthy and idle (no provider stream) without them.
        const [botId, botSecret] = await Promise.all([
          context.config.get('botId'),
          context.secrets.get('botSecret'),
        ]);
        const initialBotId = typeof botId === 'string' ? botId : '';
        const initialBotSecret = typeof botSecret === 'string' ? botSecret : '';
        // In-process adopted credentials: the activate-time snapshot trimmed at
        // load, replaced by every successful validate, cleared on disconnect.
        // Never read context.config.get / secrets.get here: they are the
        // activation-time snapshot and stay stale after a disconnect write-back.
        let adoptedBotId = initialBotId.trim();
        let adoptedBotSecret = initialBotSecret.trim();
        const bridge = await createMessageBridge(context);
        const runtime = createRuntime({
          config: {
            botId: initialBotId,
            botSecret: initialBotSecret,
          },
          host: { deliver: bridge.deliver },
          logger: context.logger,
        });
        await runtime.start();
        const mediaSource = createInboundMediaSourceActions(context, async locator => {
          const marker = '|aeskey=';
          const split = locator.platformKey.lastIndexOf(marker);
          const url = split < 0 ? locator.platformKey : locator.platformKey.slice(0, split);
          const aesKey = split < 0 ? undefined : locator.platformKey.slice(split + marker.length);
          return (await runtime.outbound.downloadMedia(url, aesKey)).buffer;
        });
        const lifecycle = createConnectorLifecycleAction(context, {
          sendPlaceholder: (externalConversationId, text) => runtime.outbound.sendPlaceholder(externalConversationId, text),
          editPlaceholder: (externalConversationId, platformMessageId, text, phase) => runtime.outbound.editMessage(
            externalConversationId,
            platformMessageId,
            text,
            { bypassThrottle: phase === 'blocked' },
          ),
          sendRecovery: (externalConversationId, text) => runtime.outbound.sendReply(externalConversationId, text),
          settle: async ({ platformMessageId }) => {
            if (platformMessageId !== undefined) await runtime.outbound.deleteMessage(platformMessageId);
          },
        });
        return {
          actions: {
            'host.messaging.lifecycle': lifecycle,
            'wecom-bot.media-source.read': mediaSource.read,
            'wecom-bot.media-source.settle': mediaSource.settle,
            'wecom-bot.validate': async (params: unknown) => {
              // Host merges stored non-secret values with the card's unsaved input
              // ({ ...stored, ...body }) and delivers it as the action's `input`.
              const provided = object(params) && object(params.input) ? params.input : {};
              const fromInput = (key: 'botId' | 'botSecret') => {
                const value = provided[key];
                return typeof value === 'string' ? value.trim() : '';
              };
              // Priority: unsaved card input → in-process adopted values. The
              // activate-time config/secrets snapshot is intentionally NOT a
              // fallback: after an owner disconnect the Host writes '' back
              // without restarting the plugin, so the snapshot still holds the
              // old credentials and would silently reconnect with them.
              const id = fromInput('botId') || adoptedBotId;
              const secret = fromInput('botSecret') || adoptedBotSecret;
              if (id.length === 0 || secret.length === 0) {
                return {
                  render: 'status',
                  data: { status: 'error', message: '未填写 Bot ID / Bot Secret — 在面板里填好，直接点测试并连接' },
                  advance: false,
                };
              }
              const result = await validateCredentials(id, secret);
              if (!result.valid) {
                return {
                  render: 'status',
                  data: { status: 'error', message: result.error ?? 'credentials rejected by provider' },
                  advance: false,
                };
              }
              adoptedBotId = id;
              adoptedBotSecret = secret;
              await runtime.connect({ botId: id, botSecret: secret });
              return {
                render: 'status',
                data: { status: 'confirmed' },
                label: '已连接',
                targetValues: { botId: id, botSecret: secret },
              };
            },
            'wecom-bot.disconnect': async () => {
              await runtime.disconnect();
              // Forget in-process adopted credentials: otherwise a later validate
              // with empty input would silently reconnect with the credentials the
              // owner just disconnected (Host write-back does not restart the plugin).
              adoptedBotId = '';
              adoptedBotSecret = '';
              return {
                render: 'status',
                data: { status: 'disconnected' },
                label: '已断开',
                targetValues: { botId: '', botSecret: '' },
              };
            },
            'wecom-bot.test': async () => {
              const ok = runtime.isConnected();
              return { ok, ...(ok ? {} : { message: `当前状态: ${runtime.getConnectionState()}` }) };
            },
            'wecom-bot.outbound': async (candidate) => {
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
                  context.log('warn', 'WeCom bot outbound delivery to one binding failed', {
                    externalConversationId: input.externalConversationId,
                    errorName: error instanceof Error ? error.name : 'unknown',
                  });
                }
              }
              if (delivered === 0) {
                if (firstFailure !== undefined) throw firstFailure;
                throw new Error(
                  'WeCom bot outbound delivery failed for all bindings (provider did not report an error)',
                );
              }
            },
          },
          dispose: () => runtime.stop(),
        };
      },
    },
  }));
}

export default createWeComBotPluginModule();

import {isPluginDeliveryInput} from '@clowder-ai/plugin-contract';
import { definePluginModule } from '@clowder-ai/plugin-sdk';
import { threadMappings } from './thread-mappings.js';
import { createWeComSettings, type SettingsEntrypoint } from './settings.js';
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

import { WeComBotAdapter } from './WeComBotAdapter.js';
import { renderTypedMediaNotice } from './media-notice.js';
import { createInboundMediaSource, releaseInboundMedia, retainInboundMedia } from './inbound-media-source.js';
import { createConnectorLifecycleAction } from './lifecycle-action.js';
import { createReplySenderMap } from './reply-sender-map.js';
import { connectorCommandFacts } from './command-ingress.js';
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
  if(!isPluginDeliveryInput(candidate)||candidate.kind!=='message')throw new TypeError('wecom-bot requires a message delivery');
  return structuredClone(candidate);
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

async function createMessageBridge(context: FeatureContext, reply: Parameters<typeof createConnectorCommandBridge>[1]['reply']) {
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
    connectorId: CONNECTOR_ID, identityId: IDENTITY_ID, reply,
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
    async deliver(message: WeComBotHostInboundMessage): Promise<void> {
      await routeCommand(connectorCommandFacts(message), async () => {
        const thread = await threadMappings(context).ensureByKey(message.externalConversationId, { title: `WeCom ${message.externalConversationId}`.slice(0, 200) });
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
      });
    },
    async outbound(candidate: unknown) {
      const input = requireDelivery(candidate);
      const bindings = (await threadMappings(context).listBindings()).filter(item => item.threadId === input.threadId);
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
        content: context.streams.read(media.reference),
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
): SettingsEntrypoint {
  const runtimeModule = definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'wecom-bot-messaging': async (context) => {
        let runtime!: ReturnType<RuntimeFactory>;
        const bridge = await createMessageBridge(context, (input, result) => runtime.outbound.sendFormattedReply(input.chatId,
          { header: 'Clowder AI', body: result.response, origin: 'callback' }));
        const configure = async () => {
          await runtime?.stop();

        // Credentials may be filled only after the plugin is enabled — the runtime
        // starts healthy and idle (no provider stream) without them.
        const [botId, botSecret] = await Promise.all([
          context.config.get('botId'),
          context.secrets.get('botSecret'),
        ]);
        const initialBotId = typeof botId === 'string' ? botId : '';
        const initialBotSecret = typeof botSecret === 'string' ? botSecret : '';
        runtime = createRuntime({
          config: {
            botId: initialBotId,
            botSecret: initialBotSecret,
          },
          host: { deliver: bridge.deliver },
          logger: {debug: (...args: unknown[]) => context.log('debug', String(args[0]), {args}),info: (...args: unknown[]) => context.log('info', String(args[0]), {args}),warn: (...args: unknown[]) => context.log('warn', String(args[0]), {args}),error: (...args: unknown[]) => context.log('error', String(args[0]), {args})},
        });
        await runtime.start();
        };
        await configure();
        const mediaSource = createInboundMediaSource(context, async locator => {
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
          configRefresh: configure,
          streams: mediaSource,
          actions: {
            ...createWeComSettings(context, validateCredentials).actions,

            'wecom-bot.test': async () => {
              const ok = runtime.isConnected();
              return { ok, ...(ok ? {} : { message: `当前状态: ${runtime.getConnectionState()}` }) };
            },
            'wecom-bot.outbound': defineDeliveryAction(async (candidate) => {
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

              return {deliveryId:candidate.deliveryId};
            }),
          },
          dispose: () => runtime.stop(),
        };
      },
    },
  }));
  return {
    create(manifest) {
      return { ...runtimeModule.create(manifest), settings: host => createWeComSettings(host, validateCredentials) };
    },
  };
}

export default createWeComBotPluginModule();

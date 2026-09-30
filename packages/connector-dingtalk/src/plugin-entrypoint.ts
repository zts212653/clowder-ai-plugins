import {
  definePlugin,
  definePluginModule,
  requireConnectorOutboundDelivery,
  type ConnectorOutboundDelivery,
  type FeatureContext,
  type PluginMessagingDelivery,
  type PluginMessagingDraft,
} from '@clowder-ai/plugin-sdk';

import {
  createDingTalkConnectorRuntime,
  type DingTalkConnectorRuntime,
  type DingTalkConnectorRuntimeOptions,
  type DingTalkHostInboundMessage,
} from './runtime.js';
import { DingTalkAdapter } from './DingTalkAdapter.js';
import { renderTypedMediaNotice } from './media-notice.js';
import { createInboundMediaSourceActions, releaseInboundMedia, retainInboundMedia, type InboundMediaLocator } from './inbound-media-source.js';
import { createConnectorLifecycleAction } from './lifecycle-action.js';
import { createReplySenderMap } from './reply-sender-map.js';

type DingTalkRuntimeFactory = (
  options: DingTalkConnectorRuntimeOptions<DingTalkAdapter>,
) => DingTalkConnectorRuntime<DingTalkAdapter>;

const CONNECTOR_ID = 'dingtalk';
const IDENTITY_ID = 'dingtalk-bot';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireDelivery(candidate: unknown): PluginMessagingDelivery {
  if (!object(candidate)) throw new TypeError('dingtalk delivery must be an object');
  const keys = Object.keys(candidate);
  if (keys.some(key => !['deliveryId', 'lifecycleId', 'threadId', 'envelope', 'presentation'].includes(key))) {
    throw new TypeError('dingtalk delivery contains an unsupported field');
  }
  if (typeof candidate.deliveryId !== 'string' || candidate.deliveryId.length === 0) {
    throw new TypeError('dingtalk deliveryId must be non-empty');
  }
  if (typeof candidate.threadId !== 'string' || candidate.threadId.length === 0) {
    throw new TypeError('dingtalk threadId must be non-empty');
  }
  if (!object(candidate.envelope) || candidate.envelope.threadId !== candidate.threadId) {
    throw new TypeError('dingtalk delivery envelope must match threadId');
  }
  return structuredClone(candidate) as unknown as PluginMessagingDelivery;
}

function title(value: string): string {
  const normalized = value.trim();
  const candidate = normalized.length > 0 ? normalized : 'DingTalk conversation';
  return candidate.length <= 200 ? candidate : candidate.slice(0, 200);
}

async function draft(context: FeatureContext, message: DingTalkHostInboundMessage) {
  const retained = await retainInboundMedia(
    context, CONNECTOR_ID, 'dingtalk-media', message.providerMessageId,
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
          kind: 'external',
          connectorId: CONNECTOR_ID,
          sourceAddress: {
            connectorId: CONNECTOR_ID,
            chatId: message.externalConversationId,
            messageId: message.providerMessageId,
          },
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
    pending = context.messaging.subscribe(threadId, { contributionId: CONNECTOR_ID })
      .catch((error: unknown) => {
        if (subscriptions.get(threadId) === pending) subscriptions.delete(threadId);
        throw error;
      });
    subscriptions.set(threadId, pending);
    return pending;
  };
  for (const binding of await context.threads.listBindings()) await subscribe(binding.threadId);
  return {
    async deliver(message: DingTalkHostInboundMessage): Promise<void> {
      const thread = await context.threads.ensureByKey(message.externalConversationId, {
        title: title(message.chatName ?? `DingTalk ${message.externalConversationId}`),
      });
      await subscribe(thread.id);
      const prepared = await draft(context, message);
      try {
        const sent = await context.messaging.send(thread.id, prepared.messageDraft);
        if (prepared.messageDraft.sender !== undefined) {
          try {
            await replySenders.record(sent.messageId, prepared.messageDraft.sender);
          } catch (error) {
            context.log('warn', 'DingTalk reply-sender mapping record failed', {
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
      if (bindings.length === 0) throw new TypeError(`dingtalk thread ${input.threadId} has no provider binding`);
      const text = input.envelope.payload.elements.flatMap((element) => {
        if (element.kind === 'text') return [element.payload.text];
        const notice = renderTypedMediaNotice(element, {
          elements: input.envelope.payload.elements,
          warnInvalid: elementId => context.log('warn', 'Invalid typed media notice ignored', { elementId }),
        });
        return notice === undefined ? [] : [notice];
      }).join('\n\n');
      const richBlocks = input.envelope.payload.elements
        .filter(element => element.kind === 'rich_block')
        .map(element => element.payload);
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
          presentation: {
            header: displayName,
            body: text,
            origin: input.envelope.actor.kind === 'cat' ? 'agent' : input.envelope.actor.kind === 'system' ? 'system' : 'direct',
          },
          ...(replyToSender === undefined ? {} : { metadata: { replyToSender } }),
          ...(richBlocks.length === 0 ? {} : { richBlocks }),
          ...(media.length === 0 ? {} : { media }),
        })),
      };
    },
  };
}

async function deliverOutbound(
  outbound: DingTalkAdapter,
  input: ConnectorOutboundDelivery,
  context: FeatureContext,
  replyPrefix: string,
): Promise<void> {
  const blocks = [...(input.richBlocks ?? [])];
  if (blocks.length > 0) {
    await outbound.sendRichMessage(
      input.externalConversationId,
      input.presentation.body,
      blocks as unknown as Parameters<DingTalkAdapter['sendRichMessage']>[2],
      input.presentation.header,
      input.metadata,
    );
  } else {
    await outbound.sendFormattedReply(
      input.externalConversationId,
      {
        ...input.presentation,
        origin: input.presentation.origin === 'callback' ? 'callback' : 'direct',
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
      context.log('warn', 'DingTalk outbound media delivery failed', {
        mediaType: media.type,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      await outbound.sendReply(
        input.externalConversationId,
        `${replyPrefix}${error instanceof RangeError ? '⚠️ 媒体过大，超过钉钉发送上限' : '⚠️ 媒体不可用（读取或上传失败）'}`,
        input.metadata,
      );
    }
  }
}

export function createDingTalkPluginModule(
  createRuntime: DingTalkRuntimeFactory = createDingTalkConnectorRuntime,
) {
  return definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'dingtalk-messaging': async (context) => {
        const appKey = await context.config.get('appKey');
        const appSecret = await context.secrets.get('appSecret');
        if (typeof appKey !== 'string') throw new TypeError('appKey must be a declared string');
        if (typeof appSecret !== 'string') throw new TypeError('appSecret must be a declared secret');
        const bridge = await createMessageBridge(context);
        const runtime = createRuntime({
          config: { appKey, appSecret },
          host: { deliver: bridge.deliver },
          logger: context.logger,
        });
        await runtime.start();
        const mediaSource = createInboundMediaSourceActions(context, locator => runtime.outbound.downloadInboundMedia(locator as InboundMediaLocator));
        const lifecycle = createConnectorLifecycleAction(context, {
          sendPlaceholder: (externalConversationId, text) => runtime.outbound.sendPlaceholder(externalConversationId, text),
          editPlaceholder: (externalConversationId, platformMessageId, text, phase) => runtime.outbound.editMessage(
            externalConversationId,
            platformMessageId,
            text,
            { bypassThrottle: phase === 'blocked' },
          ),
          sendRecovery: (externalConversationId, text) => runtime.outbound.sendReply(externalConversationId, text),
          settle: async ({ platformMessageId, recoveryText }) => {
            if (platformMessageId !== undefined) await runtime.outbound.deleteMessage(platformMessageId, recoveryText);
          },
        });
        return {
          actions: {
            'host.messaging.lifecycle': lifecycle,
            'dingtalk.media-source.read': mediaSource.read,
            'dingtalk.media-source.settle': mediaSource.settle,
            'dingtalk.outbound': async (candidate) => {
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
                  context.log('warn', 'DingTalk outbound delivery to one binding failed', {
                    externalConversationId: input.externalConversationId,
                    errorName: error instanceof Error ? error.name : 'unknown',
                  });
                }
              }
              if (delivered === 0) {
                if (firstFailure !== undefined) throw firstFailure;
                throw new Error(
                  'DingTalk outbound delivery failed for all bindings (provider did not report an error)',
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

export default createDingTalkPluginModule();

import {
  definePlugin,
  definePluginModule,
  requireConnectorOutboundDelivery,
  type ConnectorOutboundDelivery,
  type FeatureContext,
  type PluginMessagingDelivery,
  type PluginMessagingDraft,
} from '@clowder-ai/plugin-sdk';

import { WeComAgentAdapter } from './WeComAgentAdapter.js';
import { renderTypedMediaNotice } from './media-notice.js';
import { createInboundMediaSourceActions, releaseInboundMedia, retainInboundMedia } from './inbound-media-source.js';
import { createReplySenderMap } from './reply-sender-map.js';
import { renderAllRichBlocksPlaintext } from './rich-block-plaintext.js';
import {
  createWeComAgentConnectorRuntime,
  requireWeComAgentWebhookInput,
  type WeComAgentConnectorRuntime,
  type WeComAgentConnectorRuntimeOptions,
  type WeComAgentHostInboundMessage,
  type WeComAgentWebhookInput,
  type WeComAgentWebhookResult,
} from './runtime.js';

type RuntimeFactory = (
  options: WeComAgentConnectorRuntimeOptions<WeComAgentAdapter>,
) => WeComAgentConnectorRuntime<WeComAgentAdapter>;

const CONNECTOR_ID = 'wecom-agent';
const IDENTITY_ID = 'wecom-agent';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireDelivery(candidate: unknown): PluginMessagingDelivery {
  if (!object(candidate)) throw new TypeError('wecom-agent delivery must be an object');
  if (Object.keys(candidate).some(key => !['deliveryId', 'lifecycleId', 'threadId', 'envelope', 'presentation'].includes(key))) {
    throw new TypeError('wecom-agent delivery contains an unsupported field');
  }
  if (typeof candidate.deliveryId !== 'string' || candidate.deliveryId.length === 0) throw new TypeError('wecom-agent deliveryId must be non-empty');
  if (typeof candidate.threadId !== 'string' || candidate.threadId.length === 0) throw new TypeError('wecom-agent threadId must be non-empty');
  if (!object(candidate.envelope) || candidate.envelope.threadId !== candidate.threadId) throw new TypeError('wecom-agent delivery envelope must match threadId');
  return structuredClone(candidate) as unknown as PluginMessagingDelivery;
}

async function draft(context: FeatureContext, message: WeComAgentHostInboundMessage) {
  const retained = await retainInboundMedia(
    context, CONNECTOR_ID, 'wecom-agent-media', message.providerMessageId,
    (message.attachments ?? []).map(attachment => ({
      type: attachment.type, platformKey: attachment.platformKey,
      ...(attachment.fileName === undefined ? {} : { fileName: attachment.fileName }),
    })),
  );
  const messageDraft: PluginMessagingDraft = {
    idempotencyKey: message.providerMessageId,
    sourceEventId: message.providerMessageId,
    identity: IDENTITY_ID,
    sender: { id: message.externalSenderId },
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
    async deliver(message: WeComAgentHostInboundMessage): Promise<void> {
      const thread = await context.threads.ensureByKey(message.externalConversationId, { title: `WeCom ${message.externalConversationId}`.slice(0, 200) });
      await subscribe(thread.id);
      const prepared = await draft(context, message);
      try {
        const sent = await context.messaging.send(thread.id, prepared.messageDraft);
        if (prepared.messageDraft.sender !== undefined) {
          try {
            await replySenders.record(sent.messageId, prepared.messageDraft.sender);
          } catch (error) {
            context.log('warn', 'WeCom agent reply-sender mapping record failed', {
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
      if (bindings.length === 0) throw new TypeError(`wecom-agent thread ${input.threadId} has no provider binding`);
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

function forwardedWebhookInput(candidate: unknown): WeComAgentWebhookInput {
  if (!object(candidate) || !object(candidate.request)) {
    throw new TypeError('wecom-agent webhook action requires a forwarded request');
  }
  if (Object.keys(candidate).some(key => key !== 'request')) {
    throw new TypeError('wecom-agent webhook action contains an unsupported field');
  }
  const request = candidate.request;
  if ((request.method !== 'GET' && request.method !== 'POST') || request.path !== 'connectors/wecom-agent') {
    throw new TypeError('wecom-agent webhook request must match the declared GET or POST path');
  }
  return requireWeComAgentWebhookInput({ body: request.body, query: request.query });
}

function webhookHttpResponse(result: WeComAgentWebhookResult) {
  switch (result.kind) {
    case 'challenge': return { status: 200, headers: { 'content-type': 'text/plain' }, body: result.response };
    case 'processed': return { status: 200, headers: {}, body: { ok: true, messageId: result.messageId } };
    case 'skipped': return { status: 200, headers: {}, body: { ok: true, skipped: result.reason } };
    case 'error': return { status: result.status, headers: {}, body: { error: result.message } };
    default: throw new TypeError('wecom-agent webhook runtime returned an invalid result');
  }
}

async function deliverOutbound(
  outbound: WeComAgentAdapter,
  input: ConnectorOutboundDelivery,
  context: FeatureContext,
  replyPrefix: string,
): Promise<void> {
  const blocks = [...(input.richBlocks ?? [])];
  if (blocks.length > 0) {
    const text = [input.presentation.subtitle, input.presentation.body, input.presentation.footer]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join('\n\n');
    await outbound.sendReply(
      input.externalConversationId,
      replyPrefix + text + '\n\n' + renderAllRichBlocksPlaintext(blocks),
    );
  } else {
    await outbound.sendFormattedReply(input.externalConversationId, {
      header: input.presentation.header,
      body: input.presentation.body,
      origin: input.presentation.origin === 'callback' ? 'callback' : 'direct',
      ...(input.presentation.subtitle === undefined ? {} : { subtitle: input.presentation.subtitle }),
      ...(input.presentation.footer === undefined ? {} : { footer: input.presentation.footer }),
    });
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
      context.log('warn', 'WeCom agent outbound media delivery failed', {
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

export function createWeComAgentPluginModule(createRuntime: RuntimeFactory = createWeComAgentConnectorRuntime) {
  return definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'wecom-agent-messaging': async (context) => {
        const [corpId, agentId, agentSecret, callbackToken, encodingAesKey] = await Promise.all([
          context.config.get('corpId'),
          context.config.get('agentId'),
          context.secrets.get('agentSecret'),
          context.secrets.get('callbackToken'),
          context.secrets.get('encodingAesKey'),
        ]);
        if (typeof corpId !== 'string') throw new TypeError('corpId must be a declared string');
        if (typeof agentId !== 'string') throw new TypeError('agentId must be a declared string');
        if (typeof agentSecret !== 'string') throw new TypeError('agentSecret must be a declared secret');
        if (typeof callbackToken !== 'string') throw new TypeError('callbackToken must be a declared secret');
        if (typeof encodingAesKey !== 'string') throw new TypeError('encodingAesKey must be a declared secret');
        const bridge = await createMessageBridge(context);
        const runtime = createRuntime({
          config: { corpId, agentId, agentSecret, callbackToken, encodingAesKey },
          host: { deliver: bridge.deliver },
          logger: context.logger,
        });
        await runtime.start();
        const mediaSource = createInboundMediaSourceActions(context, locator => runtime.outbound.downloadMedia(locator.platformKey));
        return {
          actions: {
            'wecom-agent.media-source.read': mediaSource.read,
            'wecom-agent.media-source.settle': mediaSource.settle,
            'wecom-agent.outbound': async (candidate) => {
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
                  context.log('warn', 'WeCom agent outbound delivery to one binding failed', {
                    externalConversationId: input.externalConversationId,
                    errorName: error instanceof Error ? error.name : 'unknown',
                  });
                }
              }
              if (delivered === 0) {
                if (firstFailure !== undefined) throw firstFailure;
                throw new Error(
                  'WeCom agent outbound delivery failed for all bindings (provider did not report an error)',
                );
              }
            },
            'wecom-agent.webhook': async candidate => webhookHttpResponse(
              await runtime.handleWebhook(forwardedWebhookInput(candidate)),
            ),
          },
          dispose: () => runtime.stop(),
        };
      },
    },
  }));
}

export default createWeComAgentPluginModule();

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
  createTelegramConnectorRuntime,
  type TelegramHostInboundMessage,
  type TelegramConnectorRuntime,
  type TelegramConnectorRuntimeOptions,
} from './runtime.js';
import { TelegramAdapter } from './TelegramAdapter.js';
import { renderTypedMediaNotice } from './media-notice.js';
import { createInboundMediaSourceActions, releaseInboundMedia, retainInboundMedia } from './inbound-media-source.js';
import { createConnectorLifecycleAction } from './lifecycle-action.js';
import { createReplySenderMap } from './reply-sender-map.js';

type TelegramRuntimeFactory = (
  options: TelegramConnectorRuntimeOptions<TelegramAdapter>,
) => TelegramConnectorRuntime<TelegramAdapter>;

type TelegramOutboundDelivery = ConnectorOutboundDelivery & {
  readonly lifecycleId?: string;
};

const CONNECTOR_ID = 'telegram';
const IDENTITY_ID = 'telegram-bot';
// (lifecycleId, chatId)-keyed: one thread can back several Telegram bindings,
// and lifecycleId alone is ambiguous across them.
const INLINE_FINAL_PREFIX = 'tg-inline-final:';
// Consumed markers survive restarts so a catching_up redelivery in the
// delivered-but-not-yet-settled window cannot rewrite the delivered body.
const INLINE_FINAL_CONSUMED_PREFIX = 'tg-inline-final-consumed:';
// A pending inline-final that outlives a day was almost certainly orphaned by
// a crash or skipped delivery; the sweeping settle path already deleted the
// Telegram card, so hydrating it would only resurrect a stale correlation.
// Consumed markers share the 24h TTL convention: storage has no native TTL,
// so hydration sweeps by timestamp, exactly like the pending entries. 24h also
// matches the in-memory CONSUMED_INLINE_FINAL_TTL_MS in the adapter.
const INLINE_FINAL_TTL_MS = 24 * 60 * 60 * 1000;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireDelivery(candidate: unknown): PluginMessagingDelivery {
  if (!object(candidate)) throw new TypeError('telegram delivery must be an object');
  if (Object.keys(candidate).some(key => !['deliveryId', 'lifecycleId', 'threadId', 'envelope', 'presentation'].includes(key))) {
    throw new TypeError('telegram delivery contains an unsupported field');
  }
  if (typeof candidate.deliveryId !== 'string' || candidate.deliveryId.length === 0) {
    throw new TypeError('telegram deliveryId must be non-empty');
  }
  if (typeof candidate.threadId !== 'string' || candidate.threadId.length === 0) {
    throw new TypeError('telegram threadId must be non-empty');
  }
  if (!object(candidate.envelope) || candidate.envelope.threadId !== candidate.threadId) {
    throw new TypeError('telegram delivery envelope must match threadId');
  }
  return structuredClone(candidate) as unknown as PluginMessagingDelivery;
}

function threadTitle(externalConversationId: string): string {
  const value = `Telegram ${externalConversationId}`;
  return value.length <= 200 ? value : value.slice(0, 200);
}

async function draft(context: FeatureContext, message: TelegramHostInboundMessage) {
  const retained = await retainInboundMedia(
    context, CONNECTOR_ID, 'telegram-media', message.providerMessageId,
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
    sender: { id: message.externalSenderId },
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

interface StoredInlineFinal {
  readonly version: 1;
  readonly lifecycleId: string;
  readonly externalChatId: string;
  readonly platformMessageId: string;
  readonly registeredAt: number;
}

interface StoredInlineFinalConsumed {
  readonly version: 1;
  readonly lifecycleId: string;
  readonly externalChatId: string;
  readonly consumedAt: number;
}

function parseStoredInlineFinal(value: unknown): StoredInlineFinal | undefined {
  if (!object(value)
    || value.version !== 1
    || typeof value.lifecycleId !== 'string'
    || typeof value.externalChatId !== 'string'
    || typeof value.platformMessageId !== 'string'
    || typeof value.registeredAt !== 'number') {
    return undefined;
  }
  return value as unknown as StoredInlineFinal;
}

function parseStoredInlineFinalConsumed(value: unknown): StoredInlineFinalConsumed | undefined {
  if (!object(value)
    || value.version !== 1
    || typeof value.lifecycleId !== 'string'
    || typeof value.externalChatId !== 'string'
    || typeof value.consumedAt !== 'number') {
    return undefined;
  }
  return value as unknown as StoredInlineFinalConsumed;
}

/** Durable backing for the (lifecycleId, chatId)-keyed inline-final map and consumed markers, so a plugin restart cannot lose final↔placeholder correlation. */
function createInlineFinalPersistence(context: FeatureContext) {
  return {
    async save(entry: Omit<StoredInlineFinal, 'version'>): Promise<void> {
      await context.storage.set(`${INLINE_FINAL_PREFIX}${entry.lifecycleId}:${entry.externalChatId}`, { version: 1, ...entry });
    },
    async remove(lifecycleId: string, externalChatId: string): Promise<void> {
      await context.storage.delete(`${INLINE_FINAL_PREFIX}${lifecycleId}:${externalChatId}`).catch(() => undefined);
      // Best-effort: also clear a pre-multi-binding record keyed by lifecycleId
      // alone so an upgrade mid-flight cannot leave a stale pending entry behind.
      await context.storage.delete(`${INLINE_FINAL_PREFIX}${lifecycleId}`).catch(() => undefined);
    },
    async saveConsumed(entry: Omit<StoredInlineFinalConsumed, 'version'>): Promise<void> {
      await context.storage.set(`${INLINE_FINAL_CONSUMED_PREFIX}${entry.lifecycleId}:${entry.externalChatId}`, { version: 1, ...entry });
    },
    async removeConsumed(lifecycleId: string, externalChatId: string): Promise<void> {
      await context.storage.delete(`${INLINE_FINAL_CONSUMED_PREFIX}${lifecycleId}:${externalChatId}`).catch(() => undefined);
    },
  };
}

async function hydrateInlineFinals(context: FeatureContext, outbound: TelegramAdapter): Promise<void> {
  let listed: Readonly<Record<string, { readonly value: unknown }>>;
  try {
    listed = await context.storage.list();
  } catch (error) {
    context.log('warn', 'Telegram inline-final hydration failed', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return;
  }
  const now = Date.now();
  for (const [key, item] of Object.entries(listed)) {
    if (key.startsWith(INLINE_FINAL_CONSUMED_PREFIX)) {
      const consumed = parseStoredInlineFinalConsumed(item?.value);
      // TTL sweep: storage has no native TTL, so expired markers are deleted
      // here, mirroring the pending-entry sweep below.
      if (consumed === undefined || consumed.consumedAt + INLINE_FINAL_TTL_MS < now) {
        await context.storage.delete(key).catch(() => undefined);
        continue;
      }
      outbound.restoreInlineFinalConsumed?.(consumed.lifecycleId, consumed.externalChatId, consumed.consumedAt);
      continue;
    }
    if (!key.startsWith(INLINE_FINAL_PREFIX)) continue;
    const entry = parseStoredInlineFinal(item?.value);
    if (entry === undefined || entry.registeredAt + INLINE_FINAL_TTL_MS < now) {
      await context.storage.delete(key).catch(() => undefined);
      continue;
    }
    // Pre-multi-binding records were keyed by lifecycleId alone; their value
    // still carries externalChatId, so they hydrate onto the composite key.
    outbound.restoreInlinePlaceholder?.(entry.lifecycleId, entry.externalChatId, entry.platformMessageId, entry.registeredAt);
  }
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
    async deliver(message: TelegramHostInboundMessage): Promise<void> {
      const thread = await context.threads.ensureByKey(message.externalConversationId, {
        title: threadTitle(message.externalConversationId),
      });
      await subscribe(thread.id);
      const prepared = await draft(context, message);
      try {
        const sent = await context.messaging.send(thread.id, prepared.messageDraft);
        if (prepared.messageDraft.sender !== undefined) {
          try {
            await replySenders.record(sent.messageId, prepared.messageDraft.sender);
          } catch (error) {
            context.log('warn', 'Telegram reply-sender mapping record failed', {
              errorName: error instanceof Error ? error.name : 'unknown',
            });
          }
        }
      } catch (error) {
        await releaseInboundMedia(context, prepared.ownership, error);
        throw error;
      }
    },
    async outbound(candidate: unknown): Promise<{ inputs: TelegramOutboundDelivery[]; replyPrefix: string }> {
      const input = requireDelivery(candidate);
      const bindings = (await context.threads.listBindings()).filter(item => item.threadId === input.threadId);
      if (bindings.length === 0) throw new TypeError(`telegram thread ${input.threadId} has no provider binding`);
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
      const inputs = bindings.map(binding => {
        const delivery = requireConnectorOutboundDelivery({
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
        });
        return {
          ...delivery,
          ...(input.lifecycleId === undefined ? {} : { lifecycleId: input.lifecycleId }),
        };
      });
      return { replyPrefix, inputs };
    },
  };
}

async function deliver(
  adapter: TelegramAdapter,
  input: TelegramOutboundDelivery,
  context: FeatureContext,
  replyPrefix: string,
): Promise<void> {
  const blocks = [...(input.richBlocks ?? [])];
  if (blocks.length > 0) {
    const richBlocks = blocks as unknown as Parameters<TelegramAdapter['sendRichMessage']>[2];
    if (input.lifecycleId === undefined) {
      await adapter.sendRichMessage(
        input.externalConversationId,
        input.presentation.body,
        richBlocks,
        input.presentation.header,
      );
    } else {
      await adapter.sendRichMessage(
        input.externalConversationId,
        input.presentation.body,
        richBlocks,
        input.presentation.header,
        input.lifecycleId,
      );
    }
  } else {
    const text = replyPrefix + [input.presentation.subtitle, input.presentation.body, input.presentation.footer]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join('\n\n');
    // A non-cat media-only delivery assembles to empty text; Telegram rejects
    // empty sendMessage calls, so only send when there is something to say.
    if (text.length > 0) {
      if (input.lifecycleId === undefined) {
        await adapter.sendReply(input.externalConversationId, text);
      } else {
        await adapter.sendReply(input.externalConversationId, text, undefined, input.lifecycleId);
      }
    }
  }
  for (const media of input.media ?? []) {
    if (media.type === 'video') {
      await adapter.sendReply(input.externalConversationId, `${replyPrefix}⚠️ 视频附件暂不支持发送`, input.metadata);
      continue;
    }
    if (!media.reference.startsWith('hmr_')) {
      await adapter.sendReply(input.externalConversationId, `${replyPrefix}⚠️ 媒体不可用（旧引用无法读取）`, input.metadata);
      continue;
    }
    try {
      await adapter.sendMedia(input.externalConversationId, {
        type: media.type,
        content: context.media.read(media.reference),
        ...(media.fileName === undefined ? {} : { fileName: media.fileName }),
      });
    } catch (error) {
      context.log('warn', 'Telegram outbound media delivery failed', {
        mediaType: media.type,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      await adapter.sendReply(
        input.externalConversationId,
        `${replyPrefix}${error instanceof RangeError ? '⚠️ 媒体过大，超过 Telegram 发送上限' : '⚠️ 媒体不可用（读取或上传失败）'}`,
        input.metadata,
      );
    }
  }
}

export function createTelegramPluginModule(
  createRuntime: TelegramRuntimeFactory = createTelegramConnectorRuntime,
) {
  return definePluginModule((manifest) => definePlugin({
    manifest,
    activate: {
      'telegram-messaging': async (context) => {
        const botToken = await context.secrets.get('botToken');
        const bridge = await createMessageBridge(context);
        // The feature stays activatable without a token so telegram.test can
        // report the not-configured state; polling starts once a token exists.
        const runtime = typeof botToken === 'string' && botToken.trim().length > 0
          ? createRuntime({
            config: { botToken },
            host: { deliver: bridge.deliver },
            logger: context.logger,
            inlineFinalPersistence: createInlineFinalPersistence(context),
          })
          : undefined;
        if (runtime !== undefined) await hydrateInlineFinals(context, runtime.outbound);
        await runtime?.start();
        const mediaSource = createInboundMediaSourceActions(context, async locator => {
          if (runtime === undefined) throw new Error('Telegram Bot Token 未配置');
          return runtime.outbound.downloadInboundMedia(locator);
        });
        const lifecycle = createConnectorLifecycleAction(context, {
          sendPlaceholder: async (externalConversationId, text) => {
            if (runtime === undefined) throw new Error('Telegram Bot Token 未配置');
            return runtime.outbound.sendPlaceholder(externalConversationId, text);
          },
          editPlaceholder: async (externalConversationId, platformMessageId, text, phase, lifecycleId) => {
            if (runtime === undefined) throw new Error('Telegram Bot Token 未配置');
            // A consumed inline final already shows the delivered body in this
            // message; editing it again would overwrite the final content.
            // Returning false keeps the lifecycle action on its existing
            // fallbacks (e.g. blocked recovery send).
            if (runtime.outbound.isInlineFinalConsumed?.(lifecycleId, externalConversationId)) return false;
            const edited = await runtime.outbound.editMessage(externalConversationId, platformMessageId, text);
            if (edited && phase === 'blocked') {
              runtime.outbound.preserveInlinePlaceholder(externalConversationId, platformMessageId, lifecycleId);
            }
            return edited;
          },
          sendRecovery: async (externalConversationId, text) => {
            if (runtime === undefined) throw new Error('Telegram Bot Token 未配置');
            await runtime.outbound.sendReply(externalConversationId, text);
          },
          onPlaceholder: (externalConversationId, platformMessageId, lifecycleId) => {
            if (runtime === undefined) throw new Error('Telegram Bot Token 未配置');
            runtime.outbound.registerInlinePlaceholder(externalConversationId, platformMessageId, lifecycleId);
          },
          settle: async ({ externalConversationId, platformMessageId, recoveryText, event }) => {
            if (runtime !== undefined) {
              // The lifecycle is over; the consumed marker only protected the
              // delivered-but-not-yet-settled window. The SDK allows one
              // started per lifecycle, so without this the marker would wait
              // for the 24h TTL sweep.
              runtime.outbound.clearInlineFinalConsumed(event.lifecycleId, externalConversationId);
              if (platformMessageId !== undefined) {
                if (recoveryText !== undefined) return;
                await runtime.outbound.clearInlinePlaceholder(
                  externalConversationId,
                  platformMessageId,
                  event.lifecycleId,
                );
              }
            }
          },
        });
        return {
          actions: {
            'host.messaging.lifecycle': lifecycle,
            'telegram.media-source.read': mediaSource.read,
            'telegram.media-source.settle': mediaSource.settle,
            'telegram.test': async () => {
              if (runtime === undefined) return { ok: false, message: 'Telegram Bot Token 未配置' };
              const ok = runtime.isPolling();
              return { ok, ...(ok ? {} : { message: 'Telegram 未在轮询（Token 已配置）' }) };
            },
            'telegram.outbound': async (input) => {
              if (runtime === undefined) throw new Error('Telegram Bot Token 未配置');
              const { inputs, replyPrefix } = await bridge.outbound(input);
              // Per-binding isolation: one thread can fan out to several
              // provider bindings, and a failure on one chat must not block
              // or fail the others. A single binding keeps the old fail-fast
              // behavior so the Host redelivers; with several bindings the
              // action only rejects when every binding failed.
              let firstFailure: unknown;
              let delivered = 0;
              for (const delivery of inputs) {
                try {
                  await deliver(runtime.outbound, delivery, context, replyPrefix);
                  delivered += 1;
                } catch (error) {
                  if (firstFailure === undefined) firstFailure = error;
                  context.log('warn', 'Telegram outbound delivery to one binding failed', {
                    externalConversationId: delivery.externalConversationId,
                    errorName: error instanceof Error ? error.name : 'unknown',
                  });
                }
              }
              if (delivered === 0) {
                if (firstFailure !== undefined) throw firstFailure;
                throw new Error(
                  'Telegram outbound delivery failed for all bindings (provider did not report an error)',
                );
              }
            },
          },
          dispose: () => runtime?.stop() ?? Promise.resolve(),
        };
      },
    },
  }));
}

export default createTelegramPluginModule();

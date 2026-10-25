import { isDeepStrictEqual } from 'node:util';
import type { FeatureContext, PluginActionContext, PluginOwnerOperationContext } from '@clowder-ai/plugin-sdk';
import type { CollectiveConnector } from './business/connector/connector.js';
import { collectiveEventSourceIdentity, collectiveSourceIdentitySchema } from './business/contracts/index.js';
import { resolveMaterializedParticipation, participationError } from './business/connector/participation-custody.js';
import { isCollectiveLocalEcho } from './business/connector/public-source-custody.js';
import { collectiveSource, collectivePublicSourceBody, matchesCollectivePublicSourceBody, ingressIdempotencyKey, assertSettledCollectiveSource } from './collective-ingress-routing.js';

interface PublicSourceCallerOptions {
  readonly connector: Pick<CollectiveConnector, 'listInbox' | 'getHostRoute' | 'beginInboxRouting' | 'completeInboxRouting' |
    'recordPublicSource' | 'readCurrentPublicSource' | 'readParticipationContext' | 'withInboxRoutingAuthority'>;
  readonly native: { readonly contributionId: string; readonly methods: readonly string[] };
  readonly messaging: FeatureContext['messaging'];
  readonly pluginInstanceId: string;
  readonly threads: Pick<FeatureContext['threads'], 'get' | 'getCats'>;
}
type SourceCaller = PluginOwnerOperationContext | {
  readonly kind: 'module'; readonly userId: string; readonly pluginInstanceId: string;
  readonly signal: AbortSignal; assertCurrent(): Promise<void>;
};
const changed = () => participationError('PUBLIC_SOURCE_CHANGED', 'Exact public source or native invocation changed');

/** Ordinary exact-agent send/wake bridge. Work and channel-selection retain their original consumers. */
export function createCollectivePublicSourceCaller(options: PublicSourceCallerOptions) {
  // Module configuration is not a native tool selector. Snapshot before any asynchronous caller can mutate it.
  const native = { contributionId: options.native.contributionId, methods: [...options.native.methods].sort() };
  // A source keeps its original granted methods across a module upgrade.
  // New declarations do not add authority to that persisted binding.
  const isActiveNativeScope = (scope: { readonly contributionId: string; readonly methods: readonly string[] }) =>
    scope.contributionId === native.contributionId && scope.methods.every(method => native.methods.includes(method));
  const currentSource = async (messageRef: string, current: () => Promise<void>) => {
    await current();
    const binding = options.connector.readCurrentPublicSource(messageRef);
    const context = await options.connector.readParticipationContext(binding.source, 0, 1);
    await current();
    const after = options.connector.readCurrentPublicSource(messageRef);
    if (!isDeepStrictEqual(binding, after)) throw changed();
    return { binding, context };
  };
  return Object.freeze({
    async admitAgentEvent(connectionId: string, eventId: string, owner: SourceCaller) {
      if (owner.kind !== 'owner-operation' && owner.kind !== 'module') throw changed();
      const current = async () => { owner.signal.throwIfAborted(); await owner.assertCurrent(); owner.signal.throwIfAborted(); };
      await current();
      return options.connector.withInboxRoutingAuthority(connectionId, eventId, async (route, item) => {
        await current();
        if (route.localOwnerUserId !== owner.userId) throw changed();
        if (isCollectiveLocalEcho(item.event, connectionId)) {
          await current();
          return Object.freeze({ kind: 'local_echo' as const });
        }
        const source = collectiveEventSourceIdentity(item.event);
        if (!source || source.connectionId !== connectionId || item.event.target.kind !== 'agent' ||
          item.event.workRequest || item.event.workAcceptanceNotice || item.event.workExecutionNotice || item.event.workRevisionNotice)
          throw participationError('PUBLIC_SOURCE_UNAVAILABLE', 'This source requires its original authority consumer');
        const destination = resolveMaterializedParticipation(route, item.event.target.humanId, source.catId, source.location.channelId);
        if (!destination) throw changed();
        await options.connector.readParticipationContext(source, 0, 1); await current();
        const thread = await options.threads.get(destination.threadId);
        const cats = await options.threads.getCats(destination.threadId); await current();
        if (!thread || !cats.participants.some(cat => cat.catId === source.catId)) throw changed();
        if (item.disposition === 'routed' && item.publicSource && item.routeReceipt?.kind === 'thread_message') {
          const existing = options.connector.readCurrentPublicSource(item.publicSource.messageRef);
          if (existing.pluginInstanceId !== owner.pluginInstanceId || !isActiveNativeScope(existing.native) ||
            existing.messageRef !== `message:${item.routeReceipt.messageId}` || item.routeReceipt.threadId !== destination.threadId)
            throw changed();
          await currentSource(existing.messageRef, current);
          return { messageId: item.routeReceipt.messageId, threadId: item.routeReceipt.threadId };
        }
        await options.connector.beginInboxRouting(connectionId, eventId, route.revision); await current();
        const projected = collectiveSource(item.event, source);
        await options.connector.readParticipationContext(source, 0, 1); await current();
        // One Host operation owns storage and named wake, including retry/deduplication.
        // A lost receipt must retry this same send even if the early native caller has
        // already bound its authenticated source; that binding is not a wake receipt.
        const hostReceipt = await options.messaging.send(destination.threadId, {
          idempotencyKey: ingressIdempotencyKey(item.event), identity: 'collective', sender: projected.sender, meta: projected.meta,
          wake: { catId: source.catId },
          payload: { provenance: { origin: { kind: 'plugin', instanceId: owner.pluginInstanceId }, epistemicStatus: 'observation' },
            elements: [{ elementId: 'collective-source', kind: 'text', payload: { text: collectivePublicSourceBody(item.event) } }] },
        });
        // The builtin Host can return revision/handle/publication fields beyond the
        // SDK type. Only the original message/thread pair belongs in business custody.
        const sent = { messageId: hostReceipt.messageId, threadId: hostReceipt.threadId };
        if (sent.threadId !== destination.threadId) {
          if (item.disposition !== 'routing' || !options.messaging.get) throw changed();
          assertSettledCollectiveSource(await options.messaging.get(sent.messageId), sent, item.event, source, owner.userId);
          await options.connector.completeInboxRouting(connectionId, eventId, route.revision,
            {kind: 'thread_message', ...sent, catId: source.catId});
          // The old delivery is now accounted for. Current route permission
          // does not authorize waking or binding this historical destination.
          throw changed();
        }
        const messageRef = `message:${sent.messageId}` as const;
        try {
          const latest = (await options.connector.listInbox(connectionId)).find(item => item.event.eventId === eventId);
          const sourceNative = latest?.publicSource
            ? options.connector.readCurrentPublicSource(latest.publicSource.messageRef).native : native;
          if (!isActiveNativeScope(sourceNative)) throw changed();
          await options.connector.recordPublicSource({ connectionId, eventId, ownerUserId: owner.userId,
            pluginInstanceId: owner.pluginInstanceId, threadId: destination.threadId, messageRef, native: sourceNative });
        } finally {
          // Settling the returned Host effect is bookkeeping, not a grant: a
          // revoked endpoint still cannot bind or consume executable source.
          await options.connector.completeInboxRouting(connectionId, eventId, route.revision,
            { kind: 'thread_message', ...sent, catId: source.catId });
        }
        await currentSource(messageRef, current);
        await current();
        return sent;
      });
    },
    async resolveNative(action: PluginActionContext, method: string) {
      const resolve = async () => {
        await action.assertCurrent();
        if (!action.originTriggerMessageId || !options.messaging.get) throw changed();
        const fact = await options.messaging.get(action.originTriggerMessageId);
        await action.assertCurrent();
        if (!fact?.source) throw changed();
        const auth = { userId: action.userId, threadId: action.threadId, catId: action.catId,
          invocationId: action.invocationId, originTriggerMessageId: action.originTriggerMessageId, source: fact };
        const messageRef = `message:${auth.originTriggerMessageId}` as const;
        if (!native.methods.includes(method) || fact.userId !== auth.userId || fact.threadId !== auth.threadId ||
          fact.catId !== null || fact.source.connector !== 'collective') throw changed();
        const parsed = collectiveSourceIdentitySchema.safeParse(fact.source.meta?.participation);
        if (!parsed.success || parsed.data.catId !== auth.catId) throw changed();
        const source = parsed.data;
        const item = (await options.connector.listInbox(source.connectionId)).find(item => item.event.eventId === source.eventId);
        if (!item || !isDeepStrictEqual(collectiveEventSourceIdentity(item.event), source) || !matchesCollectivePublicSourceBody(fact.content, item.event))
          throw changed();
        await options.connector.readParticipationContext(source, 0, 1); await action.assertCurrent();
        // send(wake) can start this authenticated native invocation before send
        // returns its receipt. Bind from Host's exact origin and the original
        // Service/inbox facts, never from a native tool body or a Queue receipt.
        if (!item.publicSource) await options.connector.recordPublicSource({ connectionId: source.connectionId,
          eventId: source.eventId, ownerUserId: auth.userId, pluginInstanceId: options.pluginInstanceId,
          threadId: auth.threadId, messageRef, native });
        const { binding, context } = await currentSource(messageRef, () => action.assertCurrent());
        const event = (await options.connector.listInbox(binding.source.connectionId)).find(item => item.event.eventId === binding.source.eventId)?.event;
        if (binding.ownerUserId !== auth.userId || binding.threadId !== auth.threadId || binding.targetCatId !== auth.catId ||
          !isActiveNativeScope(binding.native) || !binding.native.methods.includes(method) ||
          fact.userId !== auth.userId || fact.threadId !== auth.threadId || fact.catId !== null ||
          options.pluginInstanceId !== binding.pluginInstanceId || fact.source.connector !== 'collective' ||
          !isDeepStrictEqual(fact.source.meta?.participation, binding.source) || !event || !matchesCollectivePublicSourceBody(fact.content, event)) throw changed();
        await action.assertCurrent();
        options.connector.readCurrentPublicSource(messageRef);
        return { auth, source: binding.source, sourceRef: messageRef, context, binding };
      };
      const resolved = await resolve();
      // Every future native mutation/reply must call this before and after its original business effect.
      return { ...resolved, revalidate: async () => {
        const after = await resolve(); if (!isDeepStrictEqual(after.binding, resolved.binding)) throw changed(); return after;
      } };
    },
  });
}

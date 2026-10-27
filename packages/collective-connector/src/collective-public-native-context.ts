import type { PluginActionContext, PluginActionHandler } from '@clowder-ai/plugin-sdk';
import { z } from 'zod';
import type { CollectiveConnector } from './business/connector/connector.js';
import { resolveMaterializedParticipation } from './business/connector/participation-custody.js';
import { collectiveArtifactCallbackCommandSchema, MESSAGE_STICKER_CATALOG } from './business/contracts/index.js';
import { executeCollectiveArtifactCommand } from './collective-artifact-command.js';
import { type CollectiveContextReferences, collectiveContextError } from './collective-context-refs.js';
import type { createCollectivePublicSourceCaller } from './collective-public-source.js';
import {
  continueWorkFromSource,
  currentWorkSourceContext,
  suggestProjectWorkFromSource,
} from './collective-work-source-context.js';
import {
  materialReadInputSchema,
  materialSuggestInputSchema,
  projectSourceContextInputSchema,
  publicTimeSuggestInputSchema,
} from './project-source-native.js';
import {
  collectiveContextReadSchema,
  collectivePublicNativeTools,
  collectiveReplySubmitSchema,
  collectiveStickerPrepareSchema,
} from './public-native-methods.js';

// These schemas preserve ca5 callback-collective-participation-routes.ts byte semantics.
const currentSchema = z.object({}).strict();
const proposeSchema = z
  .object({
    contextRef: z.string().min(1).max(256),
    requestKind: z.string().trim().min(1).max(240).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    intendedOutcome: z.string().trim().min(1).max(32000).optional(),
  })
  .strict();
const acceptSchema = z
  .object({
    contextRef: z.string().min(1).max(256),
    grantRef: z.string().trim().min(1).max(240),
    grantRevision: z.number().int().positive(),
    requestKind: z.string().trim().min(1).max(240),
    title: z.string().trim().min(1).max(200),
    intendedOutcome: z.string().trim().min(1).max(32000),
  })
  .strict();
const continueSchema = z
  .object({
    contextRef: z.string().min(1).max(256),
    workRef: z.string().min(1).max(2000),
    kind: z.enum(['resume', 'revision']),
    grantRef: z.string().trim().min(1).max(240),
    grantRevision: z.number().int().positive(),
    requestKind: z.string().trim().min(1).max(240),
  })
  .strict();
const interestSchema = z
  .object({
    contextRef: z.string().min(1).max(256),
    state: z.enum(['listen', 'withdraw']),
  })
  .strict();
interface Options {
  readonly connector: Pick<
    CollectiveConnector,
    | 'prepareReply'
    | 'submitReply'
    | 'sync'
    | 'getHostRoute'
    | 'getProjection'
    | 'readParticipationContext'
    | 'readParticipationImage'
    | 'readParticipationMedia'
    | 'prepareParticipationSticker'
    | 'readArtifactContext'
    | 'requestArtifactForAgent'
    | 'setStandingInterest'
    | 'currentWorkDecision'
    | 'readWorkSourceContext'
    | 'proposeWork'
    | 'acceptWork'
    | 'continueWork'
  > &
    Partial<Pick<CollectiveConnector, 'readProjectSource' | 'suggestMaterial' | 'suggestWorkTime'>>;
  readonly sourceCaller: Pick<ReturnType<typeof createCollectivePublicSourceCaller>, 'resolveNative'>;
  readonly references: CollectiveContextReferences;
}

/** Original public context/reply consumer, bound to authenticated exact native origin.
 * Host Work admission, private progress and unrestricted send retain their separate consumers.
 * Production declarations/entrypoint are paired separately; this factory supplies no launch authority. */
export function createCollectivePublicNativeActions(options: Options): Readonly<Record<string, PluginActionHandler>> {
  const refs = options.references,
    connector = options.connector;
  const requireSource = async (action: PluginActionContext) => {
    const resolved = await options.sourceCaller.resolveNative(action);
    const profile = async () => {
      const route = await connector.getHostRoute(resolved.source.connectionId);
      const connection = await connector.getProjection(resolved.source.connectionId);
      const participation =
        route &&
        connection.authorizedHumanId &&
        resolveMaterializedParticipation(
          route,
          connection.authorizedHumanId,
          action.catId,
          resolved.source.location.channelId,
        );
      if (!participation || route?.localOwnerUserId !== action.userId || participation.threadId !== action.threadId)
        throw collectiveContextError('PARTICIPATION_REVOKED', 'Named participant route changed');
      return participation.displayName;
    };
    const displayName = await profile();
    await resolved.revalidate();
    const revalidate = async () => {
      if ((await profile()) !== displayName)
        throw collectiveContextError('PARTICIPATION_REVOKED', 'Named participant profile changed');
      await resolved.revalidate();
    };
    return {
      ...resolved,
      displayName,
      revalidate,
      refScope: resolved.sourceRef,
      identity: {
        pluginInstanceId: resolved.binding.pluginInstanceId,
        invocationId: action.invocationId,
        catId: action.catId,
      },
      agent: {
        catId: action.catId,
        agentId: action.catId,
        displayName,
        sessionRef: action.invocationId,
      },
    };
  };
  type Binding = Awaited<ReturnType<typeof requireSource>>;
  const current = async (binding: Binding) => {
    await binding.revalidate();
    let operation = await connector.prepareReply(binding.source, binding.sourceRef, 'request');
    await binding.revalidate();
    if (operation.status === 'queued' || operation.status === 'sending') {
      await connector.sync(binding.source.connectionId);
      await binding.revalidate();
      operation = await connector.prepareReply(binding.source, binding.sourceRef, 'request');
      await binding.revalidate();
    }
    const workDecision = await connector.currentWorkDecision(binding.source);
    await binding.revalidate();
    const workSourceContext = await currentWorkSourceContext(connector, refs, binding.identity, binding);
    await binding.revalidate();
    const artifactRequests = await connector.readArtifactContext(binding.source);
    await binding.revalidate();
    return {
      kind: 'collective' as const,
      authority: 'public_participation' as const,
      workDecision,
      workSourceContext,
      artifactRequests,
      actor: binding.source.actor,
      location: binding.source.location,
      participant: binding.displayName,
      request: binding.context.source,
      stickerCatalog: MESSAGE_STICKER_CATALOG.map((entry) => ({
        id: entry.id,
        label: entry.label,
      })),
      contextRef: refs.opaqueRef(binding.identity, 'context', binding.refScope),
      returnRef: refs.opaqueRef(binding.identity, 'return', binding.refScope),
      replyOperationRef: refs.opaqueRef(binding.identity, `reply:${operation.outboxId}`, binding.refScope),
      reply: {
        status: operation.status,
        ...(operation.status !== 'prepared'
          ? {
              body: operation.body,
              author: operation.agent,
              ...(operation.attachments ? { attachments: operation.attachments } : {}),
              ...(operation.contextAttachments ? { contextAttachments: operation.contextAttachments } : {}),
              ...(operation.richBlocks ? { richBlocks: operation.richBlocks } : {}),
            }
          : {}),
        ...(operation.acceptedEventId ? { eventId: operation.acceptedEventId } : {}),
        ...(operation.failureCode ? { code: operation.failureCode } : {}),
      },
    };
  };
  const handler =
    <T>(
      schema: z.ZodType<T, z.ZodTypeDef, unknown>,
      consume: (binding: Binding, input: T) => Promise<unknown>,
    ): PluginActionHandler =>
    async (unsafe, action, hostContext) => {
      if (!action || hostContext)
        throw collectiveContextError('NOT_COLLECTIVE_ORIGIN', 'Authenticated native context is required');
      const parsed = schema.safeParse(unsafe ?? {});
      if (!parsed.success)
        throw Object.assign(parsed.error, {
          code: 'INVALID_COLLECTIVE_REQUEST',
        });
      const binding = await requireSource(action);
      const result = await consume(binding, parsed.data);
      await binding.revalidate();
      return result;
    };
  return Object.freeze({
    'collective.project.context': handler(
      projectSourceContextInputSchema,
      async (binding, input) => {
        refs.verifyRef(binding.identity, input.contextRef, 'context', binding.refScope);
        if (!connector.readProjectSource) throw new Error('Project source reader is unavailable');
        return connector.readProjectSource(binding.source);
      },
    ),
    'collective.material.read': handler(materialReadInputSchema, async (binding, input) => {
      refs.verifyRef(binding.identity, input.contextRef, 'context', binding.refScope);
      if (!connector.readProjectSource) throw new Error('Project source reader is unavailable');
      return connector.readProjectSource(binding.source, input.materialId);
    }),
    'collective.material.suggest': handler(
      materialSuggestInputSchema,
      async (binding, input) => {
        refs.verifyRef(binding.identity, input.contextRef, 'context', binding.refScope);
        if (!connector.suggestMaterial) throw new Error('Project suggestion consumer is unavailable');
        const { contextRef: _, ...command } = input;
        return connector.suggestMaterial(binding.source, command, binding.agent);
      },
    ),
    'collective.work.suggest-time': handler(
      publicTimeSuggestInputSchema,
      async (binding, input) => {
        refs.verifyRef(binding.identity, input.contextRef, 'context', binding.refScope);
        if (!connector.suggestWorkTime) throw new Error('Public date suggestion consumer is unavailable');
        const { contextRef: _, ...command } = input;
        const work = await connector.suggestWorkTime(binding.source, command, binding.agent);
        return { workId: work.workId, revision: work.revision, timeSuggestions: work.timeSuggestions ?? [] };
      },
    ),
    'collective.artifact.command': handler(
      collectiveArtifactCallbackCommandSchema,
      async (binding, input) => {
        refs.verifyRef(binding.identity, input.contextRef, 'context', binding.refScope);
        return executeCollectiveArtifactCommand(connector, binding, binding.identity, input.command);
      },
    ),
    'collective.work.suggest-project': handler(
      collectivePublicNativeTools.find((tool) => tool.method === 'collective.work.suggest-project')!.schema,
      async (binding, input) => {
        refs.verifyRef(binding.identity, input.contextRef, 'context', binding.refScope);
        return suggestProjectWorkFromSource(connector, refs, binding.identity, binding, input, binding.revalidate);
      },
    ),
    'collective.context.current': handler(currentSchema, (binding) => current(binding)),
    'collective.context.read': handler(
      collectiveContextReadSchema,
      async (binding, input) => {
        refs.verifyRef(binding.identity, input.contextRef, 'context', binding.refScope);
        await binding.revalidate();
        if (input.image) return connector.readParticipationImage(binding.source, input.image);
        if (input.attachment) return connector.readParticipationMedia(binding.source, input.attachment);
        return connector.readParticipationContext(binding.source, input.afterSequence ?? 0, input.limit ?? 30);
      },
    ),
    'collective.sticker.prepare': handler(
      collectiveStickerPrepareSchema,
      async (binding, input) => {
        refs.verifyRef(binding.identity, input.contextRef, 'context', binding.refScope);
        const operation = await connector.prepareReply(binding.source, binding.sourceRef, 'request');
        await binding.revalidate();
        return connector.prepareParticipationSticker(
          binding.source,
          input.stickerId,
          `reply-sticker:${operation.outboxId}:${input.stickerId}`,
        );
      },
    ),
    'collective.participation.set-interest': handler(
      interestSchema,
      async (binding, input) => {
        refs.verifyRef(binding.identity, input.contextRef, 'context', binding.refScope);
        const route = await connector.getHostRoute(binding.source.connectionId);
        await binding.revalidate();
        if (!route) throw collectiveContextError('PARTICIPATION_REVOKED', 'Host participation route is unavailable');
        const updated = await connector.setStandingInterest(
          binding.source.connectionId,
          {
            catId: binding.identity.catId,
            channelId: binding.source.location.channelId,
            state: input.state,
          },
          route.attentionRevision ?? 0,
        );
        await binding.revalidate();
        return {
          catId: binding.identity.catId,
          channelId: binding.source.location.channelId,
          state: input.state,
          attentionRevision: updated.attentionRevision,
        };
      },
    ),
    'collective.work.propose': handler(proposeSchema, async (binding, input) => {
      refs.verifyRef(binding.identity, input.contextRef, 'context', binding.refScope);
      await binding.revalidate();
      // Original public proposal: Service decides the matter; this grants no Task/execution authority.
      return connector.proposeWork(binding.source, `work-proposal:${binding.identity.invocationId}`, binding.agent, {
        ...(input.requestKind ? { requestKind: input.requestKind } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.intendedOutcome ? { intendedOutcome: input.intendedOutcome } : {}),
      });
    }),
    'collective.work.accept': handler(
      acceptSchema,
      async (binding, { contextRef, ...input }) => {
        refs.verifyRef(binding.identity, contextRef, 'context', binding.refScope);
        await binding.revalidate();
        const work = await connector.acceptWork(binding.source, binding.agent, input);
        await binding.revalidate();
        await connector.sync(binding.source.connectionId);
        await binding.revalidate();
        return {
          workId: work.workId,
          assignmentEventId: work.assignmentEventId,
          accountableHumanId: work.accountableHumanId,
          acceptance: work.acceptance,
          lifecycle: work.lifecycle,
          disposition: 'accepted_pending_host_admission' as const,
        };
      },
    ),
    'collective.work.continue': handler(
      continueSchema,
      async (binding, { contextRef, ...input }) => {
        refs.verifyRef(binding.identity, contextRef, 'context', binding.refScope);
        await binding.revalidate();
        return continueWorkFromSource(connector, refs, binding.identity, binding, input, binding.revalidate);
      },
    ),
    'collective.reply.submit': handler(
      collectiveReplySubmitSchema,
      async (binding, input) => {
        const operation = await connector.prepareReply(binding.source, binding.sourceRef, 'request');
        await binding.revalidate();
        refs.verifyRef(binding.identity, input.returnRef, 'return', binding.refScope);
        refs.verifyRef(binding.identity, input.replyOperationRef, `reply:${operation.outboxId}`, binding.refScope);
        await binding.revalidate();
        const { returnRef: _returnRef, replyOperationRef: _replyOperationRef, ...content } = input;
        await connector.submitReply(
          binding.source,
          binding.sourceRef,
          'request',
          operation.outboxId,
          input.attachments || input.contextAttachments || input.richBlocks ? content : input.body,
          binding.agent,
        );
        await binding.revalidate();
        await connector.sync(binding.source.connectionId);
        await binding.revalidate();
        return current(binding);
      },
    ),
  });
}

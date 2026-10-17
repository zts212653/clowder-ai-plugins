import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type {
  FeatureContext,
  PluginOwnerHttpContext,
  PluginOwnerOperationContext,
  PluginMessage,
  PluginOwnerThreadHost,
} from '@clowder-ai/plugin-sdk';
import type { CollectiveConnector } from './business/connector/connector.js';
import type { WorkReconsiderationAuthorityScope } from './business/connector/work-reconsideration.js';
import type { WorkReconsiderationBinding } from './business/connector/work-reconsideration-custody.js';
import { collectiveSourceIdentitySchema } from './business/contracts/index.js';
import { collectiveSource } from './collective-ingress-routing.js';
import { collectiveContextError } from './collective-context-refs.js';

type Purpose = Pick<WorkReconsiderationBinding, 'grantRef' | 'grantRevision' | 'requestKind'>;
/** Original ownerWakeDecision and callback purpose check, retained in the package. */
export async function ownerWakeDecision(
  connector: Pick<CollectiveConnector, 'currentWorkDecision'>,
  binding: { source: WorkReconsiderationBinding['source']; ownerWakePurpose?: Purpose },
) {
  const decision = await connector.currentWorkDecision(binding.source);
  const purpose = binding.ownerWakePurpose;
  if (!purpose) return decision;
  return {
    ...decision,
    grants: decision.grants
      .filter(
        (grant) =>
          grant.grantRef === purpose.grantRef &&
          grant.grantRevision === purpose.grantRevision &&
          grant.requestKinds.includes(purpose.requestKind),
      )
      .map((grant) => ({ ...grant, requestKinds: [purpose.requestKind] })),
  };
}
export function assertReconsiderationInput(purpose: Purpose | undefined, input: Purpose) {
  if (
    purpose &&
    (input.grantRef !== purpose.grantRef ||
      input.grantRevision !== purpose.grantRevision ||
      input.requestKind !== purpose.requestKind)
  )
    throw collectiveContextError(
      'WORK_AUTHORITY_REQUIRED',
      'Use the exact current rule and class selected by this owner wake',
    );
}

export const reconsiderationInput = z
  .object({
    sourceEventId: z.string().regex(/^evt_[A-Za-z0-9_-]{8,}$/),
    catId: z.string().trim().min(1).max(120),
    grantRef: z.string().trim().min(1).max(240),
    grantRevision: z.number().int().positive(),
    requestKind: z.string().trim().min(1).max(240),
  })
  .strict();
interface Options {
  readonly connector: Pick<
    CollectiveConnector,
    | 'withWorkReconsiderationAuthority'
    | 'recordWorkReconsiderationSource'
    | 'findWorkReconsiderationSource'
    | 'findWorkReconsiderationSourceByPurpose'
  >;
  readonly native: { readonly contributionId: string; readonly methods: readonly string[] };
  readonly messaging: Pick<FeatureContext['messaging'], 'get' | 'send'>;
  readonly ownerThreads: Pick<PluginOwnerThreadHost, 'get'>;
  readonly participantRoster: {
    listForNativeContribution(input: {
      contributionId: string;
    }): Promise<readonly { catId: string; supported: boolean }[]>;
  };
  readonly publicInvocations?: FeatureContext['publicInvocations'];
  readonly sourceFacts?: Pick<NonNullable<FeatureContext['sourceFacts']>, 'readProgress'>;
}
const unavailable = (code = 'WORK_RECONSIDERATION_SOURCE_UNAVAILABLE') =>
  Object.assign(new Error('Current source reconsideration is unavailable'), { code });

/** Original public classification: current adopted Service grant, not private Task admission.
 * send and inbox binding occur under the original fence; enqueue/verifier reentry occurs outside it. */
export function createCollectiveWorkReconsiderationCaller(options: Options) {
  const native = {
    contributionId: options.native.contributionId,
    methods: [...options.native.methods].sort(),
  };
  const activeNative = (b: WorkReconsiderationBinding) =>
    b.native.contributionId === native.contributionId &&
    b.native.methods.every((m) => native.methods.includes(m));
  const read = async (id: string, current: () => Promise<void>) => {
    if (!options.messaging.get) throw unavailable('WORK_RECONSIDERATION_UNAVAILABLE');
    await current();
    const result = await options.messaging.get(id);
    await current();
    return result;
  };
  const requireMessage = (message: PluginMessage | null, scope: WorkReconsiderationAuthorityScope) => {
    const identity = collectiveSourceIdentitySchema.safeParse(message?.source?.meta?.participation);
    if (
      !message ||
      message.catId !== null ||
      message.userId !== scope.ownerUserId ||
      message.threadId !== scope.threadId ||
      message.source?.connector !== 'collective' ||
      message.content !== scope.event.body ||
      !identity.success ||
      !isDeepStrictEqual(identity.data, scope.source)
    )
      throw unavailable();
    return message;
  };
  const original = async (scope: WorkReconsiderationAuthorityScope, current: () => Promise<void>) => {
    requireMessage(await read(scope.sourceMessageId, current), scope);
    const thread = await options.ownerThreads.get(scope.threadId);
    await current();
    if (
      !thread ||
      thread.createdBy !== scope.ownerUserId ||
      !thread.participants.includes(scope.source.catId)
    )
      throw unavailable();
    await scope.assertCurrentPermission();
    await current();
  };
  const carrier = async (
    binding: WorkReconsiderationBinding,
    scope: WorkReconsiderationAuthorityScope,
    current: () => Promise<void>,
  ) => {
    const message = requireMessage(await read(binding.messageRef.slice(8), current), scope);
    if (message.deliveryStatus === 'canceled') throw unavailable('WORK_RECONSIDERATION_WITHDRAWN');
    if (
      !isDeepStrictEqual(message.source?.meta?.reconsideration, {
        sourceMessageId: scope.sourceMessageId,
        grantRef: scope.grantRef,
        grantRevision: scope.grantRevision,
        requestKind: scope.requestKind,
        purposeKey: scope.purposeKey,
      })
    )
      throw unavailable();
    await scope.assertCurrentPermission();
    await current();
    return message;
  };
  const readCurrent = async (messageRef: string, current: () => Promise<void>) => {
    await current();
    const stored = options.connector.findWorkReconsiderationSource(messageRef);
    if (!stored) return undefined;
    if (!activeNative(stored)) throw unavailable();
    return options.connector.withWorkReconsiderationAuthority(
      stored.source.connectionId,
      stored.ownerUserId,
      {
        sourceEventId: stored.source.eventId,
        catId: stored.targetCatId,
        grantRef: stored.grantRef,
        grantRevision: stored.grantRevision,
        requestKind: stored.requestKind,
      },
      async (scope) => {
        if (
          scope.purposeKey !== stored.purposeKey ||
          scope.sourceMessageId !== stored.sourceMessageRef.slice(8) ||
          !isDeepStrictEqual(scope.source, stored.source)
        )
          throw unavailable();
        // Host's verifier context checks the carrier itself; this package independently
        // rereads the original source and current Service grant here.
        await original(scope, current);
        if (!isDeepStrictEqual(options.connector.findWorkReconsiderationSource(messageRef), stored))
          throw unavailable();
        return stored;
      },
    );
  };
  return Object.freeze({
    readCurrent,
    async reconsider(
      connectionId: string,
      input: unknown,
      owner: PluginOwnerHttpContext | PluginOwnerOperationContext,
    ) {
      const request = reconsiderationInput.parse(input);
      if (
        !['owner-http-request', 'owner-operation'].includes(owner.kind) ||
        (owner.kind === 'owner-http-request' && owner.operation !== 'write')
      )
        throw unavailable();
      const current = async () => {
        owner.signal.throwIfAborted();
        await owner.assertCurrent();
        owner.signal.throwIfAborted();
      };
      if (!options.messaging.get || !options.publicInvocations || !options.sourceFacts?.readProgress)
        throw unavailable('WORK_RECONSIDERATION_UNAVAILABLE');
      const enqueue = options.publicInvocations.enqueue.bind(options.publicInvocations),
        progress = options.sourceFacts.readProgress.bind(options.sourceFacts);
      await current();
      const cats = await options.participantRoster.listForNativeContribution({
        contributionId: native.contributionId,
      });
      await current();
      if (!cats.some((cat) => cat.catId === request.catId && cat.supported))
        throw unavailable('PARTICIPATION_UNSUPPORTED');
      const prepared = await options.connector.withWorkReconsiderationAuthority(
        connectionId,
        owner.userId,
        request,
        async (scope) => {
          await original(scope, current);
          // Use the durable purpose winner from this same inbox, never ordinary publicSource or message meta as authority.
          const existing = options.connector.findWorkReconsiderationSourceByPurpose(scope.purposeKey);
          if (existing) {
            if (existing.pluginInstanceId !== owner.pluginInstanceId || !activeNative(existing))
              throw unavailable();
            return { binding: existing, replay: true };
          }
          const projected = collectiveSource(scope.event, scope.source);
          await scope.assertCurrentPermission();
          await current();
          const sent = await options.messaging.send(scope.threadId, {
            idempotencyKey: scope.purposeKey,
            identity: 'collective',
            sender: projected.sender,
            meta: {
              ...projected.meta,
              reconsideration: {
                sourceMessageId: scope.sourceMessageId,
                grantRef: scope.grantRef,
                grantRevision: scope.grantRevision,
                requestKind: scope.requestKind,
                purposeKey: scope.purposeKey,
              },
            },
            payload: {
              provenance: {
                origin: { kind: 'plugin', instanceId: owner.pluginInstanceId },
                epistemicStatus: 'observation',
              },
              elements: [
                { elementId: 'collective-source', kind: 'text', payload: { text: scope.event.body } },
              ],
            },
          });
          await current();
          await scope.assertCurrentPermission();
          if (sent.threadId !== scope.threadId) throw unavailable();
          const binding = await options.connector.recordWorkReconsiderationSource(scope, {
            pluginInstanceId: owner.pluginInstanceId,
            messageRef: `message:${sent.messageId}`,
            native,
          });
          await current();
          await carrier(binding, scope, current);
          return { binding, replay: false };
        },
      );
      // Queue admission synchronously calls the existing verifier, which must acquire this connection fence anew.
      await current();
      await readCurrent(prepared.binding.messageRef, current);
      const verifyProgress = (fact: Awaited<ReturnType<typeof progress>>) => {
        const b = prepared.binding;
        if (
          fact.id !== b.messageRef.slice(8) ||
          fact.userId !== b.ownerUserId ||
          fact.threadId !== b.threadId ||
          fact.catId !== null ||
          fact.extra.pluginMessage.instanceId !== b.pluginInstanceId ||
          fact.source.connector !== 'collective' ||
          !isDeepStrictEqual(fact.source.meta?.participation, b.source) ||
          !isDeepStrictEqual(fact.source.meta?.reconsideration, {
            sourceMessageId: b.sourceMessageRef.slice(8),
            grantRef: b.grantRef,
            grantRevision: b.grantRevision,
            requestKind: b.requestKind,
            purposeKey: b.purposeKey,
          }) ||
          (fact.queueCustody && !isDeepStrictEqual(fact.queueCustody.allTargetCats, [b.targetCatId]))
        )
          throw unavailable();
      };
      if (prepared.replay) {
        const fact = await progress({ messageRef: prepared.binding.messageRef });
        await current();
        verifyProgress(fact);
        // Before the first Queue admission there is no protected carrier yet.
        // A response lost after send/binding must still verify the readable body.
        if (!fact.queueCustody)
          await options.connector.withWorkReconsiderationAuthority(
            connectionId,
            owner.userId,
            request,
            (scope) => carrier(prepared.binding, scope, current),
          );
        if (
          fact.queueCustody?.status === 'terminal' &&
          !fact.queueCustody.handledByCatIds.includes(request.catId)
        )
          throw unavailable('WORK_RECONSIDERATION_ALREADY_STOPPED');
      }
      const receipt = await enqueue({
        messageRef: prepared.binding.messageRef,
        targetCatId: request.catId,
        native: prepared.binding.native,
        authority: prepared.binding.authority,
      });
      await current();
      const fact = await progress({ messageRef: prepared.binding.messageRef });
      await current();
      verifyProgress(fact);
      if (!fact.queueCustody || receipt.messageRef !== prepared.binding.messageRef)
        throw unavailable('WORK_RECONSIDERATION_CUSTODY_UNAVAILABLE');
      if (
        fact.queueCustody.status === 'terminal' &&
        !fact.queueCustody.handledByCatIds.includes(request.catId)
      )
        throw unavailable('WORK_RECONSIDERATION_ALREADY_STOPPED');
      return {
        sourceEventId: request.sourceEventId,
        catId: request.catId,
        messageId: prepared.binding.messageRef.slice(8),
        threadId: prepared.binding.threadId,
        grantRef: request.grantRef,
        grantRevision: request.grantRevision,
        disposition:
          fact.queueCustody.status === 'terminal'
            ? 'already_classified'
            : prepared.replay
              ? 'already_queued'
              : 'queued',
      };
    },
  });
}

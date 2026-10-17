import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { publicSourceBindingSchema } from './public-source-custody.js';
import { participationError, requireParticipation } from './participation-custody.js';
import type { ConnectorPersistence } from './persistence.js';
import type { WorkReconsiderationAuthorityScope } from './work-reconsideration.js';
import { collectiveSourceIdentitySchema } from '../contracts/index.js';

/** Another message for the same inbox source/purpose, not another permission ledger.
 * Current Service grant is still re-read by withWorkReconsiderationAuthority. */
export const workReconsiderationBindingSchema = publicSourceBindingSchema
  .extend({
    sourceMessageRef: publicSourceBindingSchema.shape.messageRef,
    purposeKey: z.string().regex(/^collective-reconsider:[a-f0-9]{64}$/),
    grantRef: z.string().trim().min(1).max(240),
    grantRevision: z.number().int().positive(),
    requestKind: z.string().trim().min(1).max(240),
    authority: z
      .object({
        ref: z.string().regex(/^collective-reconsider:[a-f0-9]{64}$/),
        revision: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();
export type WorkReconsiderationBinding = Omit<
  z.infer<typeof workReconsiderationBindingSchema>,
  'messageRef' | 'sourceMessageRef'
> & {
  messageRef: `message:${string}`;
  sourceMessageRef: `message:${string}`;
};
type Scope = Pick<
  WorkReconsiderationAuthorityScope,
  | 'source'
  | 'event'
  | 'ownerUserId'
  | 'threadId'
  | 'sourceMessageId'
  | 'purposeKey'
  | 'grantRef'
  | 'grantRevision'
  | 'requestKind'
>;
interface RecordInput {
  readonly pluginInstanceId: string;
  readonly messageRef: `message:${string}`;
  readonly native: { readonly contributionId: string; readonly methods: readonly string[] };
}
const changed = () =>
  participationError(
    'WORK_RECONSIDERATION_SOURCE_UNAVAILABLE',
    'Exact reconsideration purpose/source changed',
  );
function make(scope: Scope, input: RecordInput) {
  if (input.messageRef === `message:${scope.sourceMessageId}`) throw changed();
  const native = publicSourceBindingSchema.shape.native.parse(input.native);
  native.methods.sort();
  const fixed = {
    pluginInstanceId: input.pluginInstanceId,
    ownerUserId: scope.ownerUserId,
    threadId: scope.threadId,
    messageRef: input.messageRef,
    sourceMessageRef: `message:${scope.sourceMessageId}`,
    targetCatId: scope.source.catId,
    source: collectiveSourceIdentitySchema.parse(scope.source),
    native,
    purposeKey: scope.purposeKey,
    grantRef: scope.grantRef,
    grantRevision: scope.grantRevision,
    requestKind: scope.requestKind,
  };
  return workReconsiderationBindingSchema.parse({
    ...fixed,
    authority: {
      ref: scope.purposeKey,
      revision: createHash('sha256')
        .update(JSON.stringify([fixed, scope.event.body]))
        .digest('hex'),
    },
  }) as WorkReconsiderationBinding;
}
export function findWorkReconsiderationSource(
  persistence: ConnectorPersistence,
  messageRef: string,
): WorkReconsiderationBinding | undefined {
  const state = persistence.snapshot();
  const matches = persistence
    .reconsiderationSources()
    .filter((binding) => binding.messageRef === messageRef)
    .map((binding) => ({
      binding,
      item: state.connections[binding.source.connectionId]?.inbox.find(
        (item) => item.event.eventId === binding.source.eventId,
      ),
    }));
  if (!matches.length) return undefined;
  if (matches.length !== 1) throw changed();
  const { item, binding } = matches[0]!;
  if (!item) throw changed();
  const { route, binding: participation } = requireParticipation(state, binding.source);
  if (
    item.disposition !== 'routed' ||
    item.routeReceipt?.kind !== 'thread_message' ||
    `message:${item.routeReceipt.messageId}` !== binding.sourceMessageRef ||
    item.routeReceipt.threadId !== binding.threadId ||
    route.localOwnerUserId !== binding.ownerUserId ||
    participation.threadId !== binding.threadId ||
    item.event.eventId !== binding.source.eventId
  )
    throw changed();
  const expected = make(
    { ...binding, event: item.event, sourceMessageId: item.routeReceipt.messageId },
    binding,
  );
  if (!isDeepStrictEqual(binding, expected)) throw changed();
  return structuredClone(binding);
}
export function findWorkReconsiderationSourceByPurpose(
  persistence: ConnectorPersistence,
  purposeKey: string,
) {
  const matches = persistence.reconsiderationSources().filter((binding) => binding.purposeKey === purposeKey);
  if (!matches.length) return undefined;
  if (matches.length !== 1) throw changed();
  return findWorkReconsiderationSource(persistence, matches[0]!.messageRef);
}
export async function recordWorkReconsiderationSource(
  persistence: ConnectorPersistence,
  scope: WorkReconsiderationAuthorityScope,
  input: RecordInput,
) {
  const binding = make(scope, structuredClone(input));
  await scope.assertCurrentPermission();
  return persistence.transactionReconsiderationSources(
    (state, bindings) => {
      const { route, binding: participation } = requireParticipation(state, scope.source);
      const item = state.connections[scope.source.connectionId]?.inbox.find(
        (x) => x.event.eventId === scope.source.eventId,
      );
      if (
        !item ||
        !isDeepStrictEqual(item.event, scope.event) ||
        item.disposition !== 'routed' ||
        item.routeReceipt?.kind !== 'thread_message' ||
        item.routeReceipt.messageId !== scope.sourceMessageId ||
        item.routeReceipt.threadId !== scope.threadId ||
        route.localOwnerUserId !== scope.ownerUserId ||
        participation.threadId !== scope.threadId
      )
        throw changed();
      const existing = bindings.find((x) => x.purposeKey === binding.purposeKey);
      if (existing) {
        if (!isDeepStrictEqual(existing, binding)) throw changed();
        return structuredClone(existing);
      }
      if (
        bindings.some((b) => b.messageRef === binding.messageRef) ||
        Object.values(state.connections).some((c) =>
          c.inbox.some((x) => x.publicSource?.messageRef === binding.messageRef),
        )
      )
        throw changed();
      bindings.push(binding);
      return structuredClone(binding);
    },
    () => scope.assertCurrentPermission(),
  );
}

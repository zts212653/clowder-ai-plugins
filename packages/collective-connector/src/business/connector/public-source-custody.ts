import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { collectiveEventSourceIdentity, collectiveSourceIdentitySchema, type CollectiveEventEnvelope } from '../contracts/index.js';
import { requireParticipation, participationError } from './participation-custody.js';
import type { ConnectorPersistence } from './persistence.js';
import type { ConnectorInboxItem, ConnectorState } from './state.js';

const boundedCoordinate = (max = 512) => z.string().min(1).max(max).refine(value => value.trim() === value && !/[\x00-\x1f\x7f]/u.test(value));
const nativeSchema = z.object({ contributionId: boundedCoordinate(256), methods: z.array(boundedCoordinate(256)).min(1).max(256)
  .refine(methods => new Set(methods).size === methods.length) }).strict();
export const publicSourceBindingSchema = z.object({
  pluginInstanceId: boundedCoordinate(), ownerUserId: boundedCoordinate(), threadId: boundedCoordinate(),
  messageRef: z.string().regex(/^message:\S{1,500}$/u).refine(value => value.slice(8).length <= 512 && !/[\x00-\x1f\x7f]/u.test(value)),
  targetCatId: boundedCoordinate(), source: collectiveSourceIdentitySchema,
  native: nativeSchema,
}).strict();
export type CollectivePublicSourceBinding = z.infer<typeof publicSourceBindingSchema>;
export interface RecordPublicSourceInput {
  readonly connectionId: string;
  readonly eventId: string;
  /** Supplied by the authenticated owner operation, never a native tool body. */
  readonly pluginInstanceId: string;
  readonly ownerUserId: string;
  readonly threadId: string;
  readonly messageRef: `message:${string}`;
  /** Supplied by the owning module's declared native contribution. */
  readonly native: { readonly contributionId: string; readonly methods: readonly string[] };
}
const denied = () => participationError('PUBLIC_SOURCE_CHANGED', 'Exact public source binding is no longer current');

/** Original dispatcher preflight: ordinary Agent echo never requests another invocation.
 * Work acceptance/execution notices keep their independent original consumer. */
export function isCollectiveLocalEcho(event: CollectiveEventEnvelope, connectionId: string): boolean {
  return event.actor.kind === 'agent' && event.actor.provenance.connectionId === connectionId &&
    !event.workAcceptanceNotice && !event.workExecutionNotice;
}

function sourceOf(item: ConnectorInboxItem, connectionId: string) {
  if (isCollectiveLocalEcho(item.event, connectionId))
    throw participationError('PUBLIC_SOURCE_LOCAL_ECHO', 'Local Agent echo cannot become an executable public source');
  // Purpose-winner, private Work and channel-attention selection are separate original consumers.
  // This slice pairs only the ordinary exact-agent ingress; none can borrow this binding.
  if (item.event.workRequest || item.event.workAcceptanceNotice || item.event.workExecutionNotice || item.event.workRevisionNotice)
    throw participationError('PUBLIC_SOURCE_UNAVAILABLE', 'This event requires its original Work authority consumer');
  const source = collectiveEventSourceIdentity(item.event);
  if (!source || item.event.target.kind !== 'agent' || source.catId !== item.event.target.agentId)
    throw participationError('PUBLIC_SOURCE_UNAVAILABLE', 'Exact agent source is required');
  return source;
}

function makeBinding(state: ConnectorState, item: ConnectorInboxItem, input: RecordPublicSourceInput): CollectivePublicSourceBinding {
  const source = sourceOf(item, input.connectionId), { connection, route, binding } = requireParticipation(state, source);
  if (source.connectionId !== input.connectionId || connection.authorizedHumanId !==
    (item.event.target.kind === 'agent' ? item.event.target.humanId : undefined) ||
    route.localOwnerUserId !== input.ownerUserId || binding.threadId !== input.threadId) throw denied();
  const native = nativeSchema.parse(input.native); native.methods.sort();
  const fixed = { pluginInstanceId: input.pluginInstanceId, ownerUserId: input.ownerUserId,
    threadId: input.threadId, messageRef: input.messageRef, targetCatId: source.catId, source, native };
  return publicSourceBindingSchema.parse(fixed);
}

export function readCurrentPublicSource(persistence: ConnectorPersistence, messageRef: string): CollectivePublicSourceBinding {
  const state = persistence.snapshot();
  const matches = Object.values(state.connections).flatMap(connection => connection.inbox.filter(item => item.publicSource?.messageRef === messageRef));
  if (matches.length !== 1) throw participationError('PUBLIC_SOURCE_UNAVAILABLE', 'Exact durable public source is unavailable');
  const item = matches[0]!, stored = item.publicSource!;
  const expected = makeBinding(state, item, { ...stored, connectionId: stored.source.connectionId, eventId: stored.source.eventId,
    messageRef: stored.messageRef as `message:${string}` });
  if (!isDeepStrictEqual(stored, expected)) throw denied();
  return structuredClone(stored);
}

export async function recordPublicSource(persistence: ConnectorPersistence, input: RecordPublicSourceInput): Promise<CollectivePublicSourceBinding> {
  // Capture the caller's configuration before the transaction waits for its existing writer tail.
  const captured = structuredClone(input);
  return persistence.transaction(state => {
    const item = state.connections[captured.connectionId]?.inbox.find(candidate => candidate.event.eventId === captured.eventId);
    if (!item) throw participationError('PUBLIC_SOURCE_UNAVAILABLE', 'Service event is not in this Connector inbox');
    const binding = makeBinding(state, item, captured);
    if (item.publicSource) {
      if (!isDeepStrictEqual(item.publicSource, binding)) throw denied();
      return structuredClone(binding);
    }
    if (item.disposition !== 'routing' || item.routeConfigRevision !== state.hostRoutes[captured.connectionId]?.revision)
      throw participationError('PUBLIC_SOURCE_UNAVAILABLE', 'Public source must belong to the current inbox routing attempt');
    if (Object.values(state.connections).some(connection => connection.inbox.some(candidate => candidate.publicSource?.messageRef === binding.messageRef))) throw denied();
    item.publicSource = binding;
    return structuredClone(binding);
  });
}

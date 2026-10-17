import { ConnectorTransportError } from './business/connector/service-client.js';
import { isDeepStrictEqual } from 'node:util';
import type { PluginMessage } from '@clowder-ai/plugin-sdk';
import type { HostRouteConfig } from './business/connector/state.js';
import type { CollectiveEventEnvelope, CollectiveSourceIdentity } from './business/contracts/index.js';
interface ConnectorSource {
  readonly connector: string; readonly label: string; readonly icon: string;
  readonly sender: { readonly id: string; readonly name: string };
  readonly meta: Readonly<Record<string, unknown>>;
}
import { collectiveEventSourceIdentity } from './business/contracts/index.js';

interface CollectiveIngressSocketManager {
  broadcastToRoom(room: string, event: string, data: unknown): void;
}

export function missingAgentRoute(route: HostRouteConfig, humanId: string, catId: string) {
  const knownParticipant =
    route.agentRoutes[`${humanId}:${catId}`] ||
    Object.values(route.channelRoutes ?? {}).some((endpoint) => endpoint.participants[catId]);
  return knownParticipant
    ? ingressError('PARTICIPATION_REVOKED', 'Exact public participation is unavailable for this Channel')
    : ingressError('ROUTE_AGENT_UNCONFIGURED', 'Agent target has no Host Channel route');
}

export function selectStandingInterest(
  route: HostRouteConfig,
  channelId: string,
  participants: Readonly<Record<string, unknown>>,
  isCatAvailable: (catId: string) => boolean,
) {
  return Object.values(route.standingInterests?.[channelId] ?? {})
    .filter(
      (interest) =>
        interest.status === 'active' && Boolean(participants[interest.catId]) && isCatAvailable(interest.catId),
    )
    .sort((left, right) => left.revision - right.revision || left.catId.localeCompare(right.catId))[0];
}

export function attentionSource(
  event: CollectiveEventEnvelope,
  connectionId: string,
  catId: string,
  participationRevision: number,
): CollectiveSourceIdentity {
  if (!event.location) throw ingressError('LOCATION_REQUIRED', 'Attention request has no public Channel location');
  return {
    serviceInstanceId: event.serviceInstanceId,
    collectiveId: event.collectiveId,
    connectionId,
    eventId: event.eventId,
    location: event.location,
    catId,
    participationRevision,
    actor: event.actor,
  };
}

export function ingressIdempotencyKey(event: CollectiveEventEnvelope): string {
  return `collective-ingress:${event.serviceInstanceId}:${event.collectiveId}:${event.eventId}`;
}

/** Reconcile an earlier pending send from actual owned Host storage.
 * The receipt comes from this instance's Host send ledger; message reading
 * checks content identity only, never callback identity or execution permission. */
export function assertSettledCollectiveSource(message: PluginMessage | null, receipt: {messageId: string; threadId: string},
  event: CollectiveEventEnvelope, source: CollectiveSourceIdentity, ownerUserId: string): void {
  if (!message || message.id !== receipt.messageId || message.threadId !== receipt.threadId || message.catId !== null ||
    message.userId !== ownerUserId || message.content !== event.body ||
    message.source?.connector !== 'collective' || !isDeepStrictEqual(message.source.meta, collectiveSource(event, source).meta))
    throw ingressError('ROUTE_RECEIPT_CHANGED', 'Prior Host source receipt does not match this exact Collective event');
}

export function collectiveSender(event: CollectiveEventEnvelope): { id: string; name: string } {
  if (event.actor.kind === 'human') return { id: event.actor.humanId, name: event.actor.displayName };
  return {
    id: `${event.actor.human.humanId}:${event.actor.agent.agentId}`,
    name: `${event.actor.agent.displayName} · ${event.actor.human.displayName}`,
  };
}

export function collectiveSource(
  event: CollectiveEventEnvelope,
  participation?: CollectiveSourceIdentity,
): ConnectorSource {
  const sourceIdentity = participation ?? collectiveEventSourceIdentity(event);
  return {
    connector: 'collective',
    label: 'Collective',
    icon: 'collective',
    sender: collectiveSender(event),
    meta: {
      serviceInstanceId: event.serviceInstanceId,
      collectiveId: event.collectiveId,
      eventId: event.eventId,
      sequence: event.sequence,
      target: event.target,
      ...(event.location ? { location: event.location } : {}),
      ...(event.recipient ? { recipient: event.recipient } : {}),
      actor: event.actor,
      ...(event.attentionRequest ? { attentionRequest: event.attentionRequest } : {}),
      ...(event.workRequest ? { workRequest: event.workRequest } : {}),
      ...(event.workRevisionNotice ? { workRevisionNotice: event.workRevisionNotice } : {}),
      ...(event.workAcceptanceNotice ? { workAcceptanceNotice: event.workAcceptanceNotice } : {}),
      ...(event.workExecutionNotice ? { workExecutionNotice: event.workExecutionNotice } : {}),
      ...(sourceIdentity ? { participation: sourceIdentity } : {}),
    },
  };
}

export function emitConnectorMessage(
  socketManager: CollectiveIngressSocketManager,
  threadId: string,
  messageId: string,
  event: CollectiveEventEnvelope,
  source: ConnectorSource,
): void {
  socketManager.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
    threadId,
    message: {
      id: messageId,
      type: 'connector',
      content: event.body,
      source,
      timestamp: Date.parse(event.acceptedAt),
    },
  });
}

export function ingressError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function routeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ConnectorTransportError && error.retryable)
    return { code: 'COLLECTIVE_SERVICE_UNAVAILABLE', message: error.message.slice(0, 500) };
  if (error instanceof Error) {
    const candidate = 'code' in error ? error.code : undefined;
    const code =
      typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(candidate) ? candidate : 'ROUTE_DELIVERY_FAILED';
    return { code, message: error.message.slice(0, 500) || 'Collective ingress routing failed' };
  }
  return { code: 'ROUTE_DELIVERY_FAILED', message: 'Collective ingress routing failed' };
}

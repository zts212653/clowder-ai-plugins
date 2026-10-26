import { isDeepStrictEqual } from 'node:util';
import type { PluginMessage } from '@clowder-ai/plugin-sdk';
import { ConnectorTransportError } from './business/connector/service-client.js';
import type { HostRouteConfig } from './business/connector/state.js';
import type { CollectiveEventEnvelope, CollectiveSourceIdentity } from './business/contracts/index.js';

interface ConnectorSource {
  readonly connector: string;
  readonly label: string;
  readonly icon: string;
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

/** A source-only message must still tell the model what it can inspect.
 * These immutable references disclose no URL, private draft or attachment bytes. */
export function collectivePublicSourceBody(event: CollectiveEventEnvelope): string {
  const rich = event.richBlocks?.length
    ? `[Collective public rich content preview: eventId=${event.eventId}]\n` +
      event.richBlocks
        .map((block) =>
          JSON.stringify({
            kind: block.kind,
            id: block.id.slice(0, 200),
            ...('title' in block && block.title ? { title: block.title.slice(0, 240) } : {}),
          }),
        )
        .join('\n') +
      '\nUse cat_cafe_collective_read_context with the current contextRef to read the original public rich content. This preview is not the full content.'
    : undefined;
  const body = [
    event.body,
    ...(event.contextAttachments ?? []).map((quote) => `[Collective public quote]\n${JSON.stringify(quote)}`),
    rich,
  ]
    .filter(Boolean)
    .join('\n\n');
  if (!event.attachments?.length) return body;
  const attachments = event.attachments
    .map(({ attachmentId, fileName, mediaType }) => JSON.stringify({ attachmentId, fileName, mediaType }))
    .join('\n');
  return (
    `${body}${body ? '\n\n' : ''}[Collective public attachments: eventId=${event.eventId}]\n${attachments}\n` +
    'Read current context, then use cat_cafe_collective_read_context with contextRef and image={eventId,attachmentId} for pixels, or attachment={eventId,attachmentId,startSeconds?,durationSeconds?} for supported original text/audio/video. Inspect the returned content and any truncation/unavailable status; references alone do not prove that content was read.'
  );
}

export function matchesCollectivePublicSourceBody(content: string, event: CollectiveEventEnvelope) {
  // Already delivered body-only sources retain their exact historical binding after an upgrade.
  return content === event.body || content === collectivePublicSourceBody(event);
}

/** Reconcile an earlier pending send from actual owned Host storage.
 * The receipt comes from this instance's Host send ledger; message reading
 * checks content identity only, never callback identity or execution permission. */
export function assertSettledCollectiveSource(
  message: PluginMessage | null,
  receipt: { messageId: string; threadId: string },
  event: CollectiveEventEnvelope,
  source: CollectiveSourceIdentity,
  ownerUserId: string,
): void {
  if (
    !message ||
    message.id !== receipt.messageId ||
    message.threadId !== receipt.threadId ||
    message.catId !== null ||
    message.userId !== ownerUserId ||
    !matchesCollectivePublicSourceBody(message.content, event) ||
    message.source?.connector !== 'collective' ||
    !isDeepStrictEqual(message.source.meta, collectiveSource(event, source).meta)
  )
    throw ingressError('ROUTE_RECEIPT_CHANGED', 'Prior Host source receipt does not match this exact Collective event');
}

export function collectiveSender(event: CollectiveEventEnvelope): {
  id: string;
  name: string;
} {
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
      ...(event.workWakeNotice ? { workWakeNotice: event.workWakeNotice } : {}),
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
      from: {
        kind: 'external',
        connectorId: source.connector,
        sender: collectiveSender(event),
      },
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

export function routeFailure(error: unknown): {
  code: string;
  message: string;
} {
  if (error instanceof ConnectorTransportError && error.retryable)
    return {
      code: 'COLLECTIVE_SERVICE_UNAVAILABLE',
      message: error.message.slice(0, 500),
    };
  if (error instanceof Error) {
    const candidate = 'code' in error ? error.code : undefined;
    const code =
      typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(candidate) ? candidate : 'ROUTE_DELIVERY_FAILED';
    return {
      code,
      message: error.message.slice(0, 500) || 'Collective ingress routing failed',
    };
  }
  return {
    code: 'ROUTE_DELIVERY_FAILED',
    message: 'Collective ingress routing failed',
  };
}

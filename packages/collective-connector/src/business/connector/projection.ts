import type { CollectiveClientAnchor } from '../contracts/index.js';

import type { ConnectorConnectionState, HostRouteConfig, LocalAttempt } from './state.js';

export interface ConnectorProjection {
  readonly serviceUrl: string;
  readonly canonicalClientAnchor: CollectiveClientAnchor;
  readonly serviceInstanceId: string;
  readonly collectiveId: string;
  readonly connectionId: string;
  readonly endpointId: string;
  readonly authorizedHumanId?: string;
  readonly endpointLabel: string;
  readonly initialExcludedCatIds?: readonly string[];
  readonly authorityStatus: 'connected' | 'revoking' | 'revoked';
  readonly revocationReason?: 'owner_revoked' | 'identity_rebind_required' | 'service_revoked';
  readonly liveStatus: 'online' | 'offline';
  readonly lastAckedSequence: number;
  readonly outbox: { readonly queued: number; readonly accepted: number };
  readonly route: { readonly configured: boolean; readonly revision?: number };
  readonly inbox: {
    readonly persisted: number;
    readonly pending: number;
    readonly routed: number;
    readonly failed: number;
    readonly latestFailure?: { readonly code: string; readonly message: string };
  };
  readonly recovery?: { readonly held: number; readonly operations: readonly {
    readonly operationId: string; readonly kind: LocalAttempt['kind']; readonly revision: number;
    readonly effect: LocalAttempt['effect']; readonly reason: string; readonly choices: readonly ('reconcile' | 'resume')[];
  }[] };
  readonly lastError?: string;
  readonly lastErrorCode?: string;
}

/** Retained history has no replay affordance after its endpoint authority is gone. */
export function recoveryChoices(connection: ConnectorConnectionState, attempt: LocalAttempt): readonly ('reconcile' | 'resume')[] {
  if (attempt.status !== 'held' || !connection.endpointCredential || !connection.authorizedHumanId ||
    (attempt.kind === 'revoke' ? connection.authorityStatus !== 'revoking' : connection.authorityStatus !== 'connected')) return [];
  return ['not_started', 'replay_safe'].includes(attempt.proof) ? ['reconcile', 'resume'] : ['reconcile'];
}

export function projectConnection(connection: ConnectorConnectionState, route?: HostRouteConfig): ConnectorProjection {
  const latestFailure = [...connection.inbox]
    .reverse()
    .find((item) => item.disposition === 'route_failed')?.routeFailure;
  const held = (connection.localAttempts ?? []).filter(item => item.status !== 'settled');
  return {
    serviceUrl: connection.serviceUrl,
    canonicalClientAnchor: {
      kind: 'collective-client',
      serviceUrl: connection.serviceUrl,
      clientBuildId: connection.clientBuildId,
      serviceInstanceId: connection.serviceInstanceId,
      collectiveId: connection.collectiveId,
      connectionId: connection.connectionId,
    },
    serviceInstanceId: connection.serviceInstanceId,
    collectiveId: connection.collectiveId,
    connectionId: connection.connectionId,
    endpointId: connection.endpointId,
    ...(connection.authorizedHumanId ? { authorizedHumanId: connection.authorizedHumanId } : {}),
    endpointLabel: connection.endpointLabel,
    ...(connection.initialExcludedCatIds ? { initialExcludedCatIds: [...connection.initialExcludedCatIds] } : {}),
    authorityStatus: connection.authorityStatus,
    ...(connection.revocationReason ? { revocationReason: connection.revocationReason } : {}),
    liveStatus: connection.liveStatus,
    lastAckedSequence: connection.lastAckedSequence,
    outbox: {
      queued: connection.outbox.filter((item) => item.status === 'queued' || item.status === 'sending').length,
      accepted: connection.outbox.filter((item) => item.status === 'accepted').length,
    },
    route: {
      configured: route !== undefined,
      ...(route ? { revision: route.revision } : {}),
    },
    inbox: {
      persisted: connection.inbox.length,
      pending: connection.inbox.filter((item) => item.disposition === 'persisted' || item.disposition === 'routing')
        .length,
      routed: connection.inbox.filter((item) => item.disposition === 'routed').length,
      failed: connection.inbox.filter((item) => item.disposition === 'route_failed').length,
      ...(latestFailure ? { latestFailure: structuredClone(latestFailure) } : {}),
    },
    ...(held.length ? { recovery: { held: held.length, operations: held.slice(0, 100).map(item => ({
      operationId: item.operationId, kind: item.kind, revision: item.revision, effect: item.effect, reason: item.reason,
      choices: recoveryChoices(connection, item),
    })) } } : {}),
    ...(connection.lastError ? { lastError: connection.lastError } : {}),
    ...(connection.lastErrorCode ? { lastErrorCode: connection.lastErrorCode } : {}),
  };
}

import type { CollectiveMemberDirectory, CollectiveParticipant } from '../contracts/index.js';
import type { ServiceState } from './state.js';

// Authorization stays at the caller. These projections are shared so invite counts match the member view.
export function projectMemberDirectory(state: ServiceState, collectiveId: string): CollectiveMemberDirectory {
  const humans = Object.values(state.memberships)
    .filter((membership) => membership.collectiveId === collectiveId && membership.status === 'active')
    .flatMap((membership) => {
      const member = state.humans[membership.humanId];
      return member
        ? [
            {
              humanId: member.humanId,
              displayName: member.displayName,
              role: membership.role,
              ...(member.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
            },
          ]
        : [];
    });
  const memberIds = new Set(humans.map((member) => member.humanId));
  const cafes = Object.values(state.connections).flatMap((connection) =>
    connection.collectiveId === collectiveId &&
    connection.status === 'connected' &&
    connection.authorizedHumanId &&
    memberIds.has(connection.authorizedHumanId)
      ? [
          {
            connectionId: connection.connectionId,
            endpointId: connection.endpointId,
            endpointLabel: connection.endpointLabel,
            humanId: connection.authorizedHumanId,
          },
        ]
      : [],
  );
  return { humans, cafes };
}

export function projectParticipants(state: ServiceState, collectiveId: string): CollectiveParticipant[] {
  return Object.values(state.participations)
    .filter((declaration) => declaration.collectiveId === collectiveId)
    .flatMap((declaration) => {
      const connection = state.connections[declaration.connectionId];
      const owner = connection?.authorizedHumanId ? state.humans[connection.authorizedHumanId] : undefined;
      if (!connection || !owner) return [];
      const membership = state.memberships[`${collectiveId}:${owner.humanId}`];
      return declaration.agents.map((agent) => ({
        serviceInstanceId: state.serviceInstanceId,
        collectiveId,
        connectionId: connection.connectionId,
        endpointId: connection.endpointId,
        endpointLabel: connection.endpointLabel,
        humanId: owner.humanId,
        humanDisplayName: owner.displayName,
        ...agent,
        participationRevision: declaration.revision,
        availability:
          connection.status === 'connected' && membership?.status === 'active'
            ? ('declared' as const)
            : ('revoked' as const),
      }));
    });
}

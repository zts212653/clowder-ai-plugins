import { requireNoArtifactCustody } from './artifact-revocation-guard.js';
import { CollectiveServiceError } from './errors.js';
import { requireHumanAuthBinding, resolveSession } from './identity-store.js';
import type { PersistentServiceState } from './persistence.js';
import type { MembershipRecord } from './service-records.js';
import { type MutableServiceState, membershipKey, type ServiceState } from './state.js';

export async function leaveCollectiveMembership(
  persistence: PersistentServiceState,
  now: () => number,
  input: { readonly sessionToken: string; readonly collectiveId: string },
): Promise<MembershipRecord> {
  return persistence.transaction((state) => {
    const { human } = resolveSession(state, input.sessionToken);
    requireHumanAuthBinding(state, human.humanId);
    if (!state.collectives[input.collectiveId]) {
      throw new CollectiveServiceError('COLLECTIVE_NOT_FOUND', 'Collective was not found', 404);
    }
    const membership = state.memberships[membershipKey(input.collectiveId, human.humanId)];
    if (!membership) {
      throw new CollectiveServiceError('FORBIDDEN', 'Collective membership is required', 403);
    }
    if (membership.status === 'left') return structuredClone(membership);
    if (membership.role === 'steward') {
      throw new CollectiveServiceError(
        'MEMBERSHIP_HANDOFF_REQUIRED',
        'A Collective steward must hand off governance before leaving',
        409,
      );
    }
    requireNoMemberArtifactCustody(state, input.collectiveId, human.humanId);
    const ownsOpenWork = Object.values(state.works).some(
      (work) =>
        work.collectiveId === input.collectiveId &&
        work.accountableHumanId === human.humanId &&
        !['completed', 'declined', 'cancelled'].includes(work.lifecycle),
    );
    const ownsActiveRoadmap = Object.values(state.roadmaps).some(
      (roadmap) =>
        roadmap.collectiveId === input.collectiveId &&
        roadmap.accountableHumanId === human.humanId &&
        roadmap.status === 'active',
    );
    if (ownsOpenWork || ownsActiveRoadmap) {
      throw new CollectiveServiceError(
        'MEMBERSHIP_RESPONSIBILITY_REQUIRED',
        'Finish, cancel, or hand off current Collective responsibilities before leaving',
        409,
      );
    }
    const leftAt = new Date(now()).toISOString();
    membership.status = 'left';
    membership.revision += 1;
    membership.leftAt = leftAt;
    membership.leaveReason = 'self_left';
    membership.history.push({
      revision: membership.revision,
      action: 'left',
      at: leftAt,
      role: membership.role,
      reason: 'self_left',
    });
    revokeMembershipConnections(state, input.collectiveId, human.humanId, leftAt);
    return structuredClone(membership);
  });
}

function revokeMembershipConnections(
  state: MutableServiceState,
  collectiveId: string,
  humanId: string,
  leftAt: string,
): void {
  for (const connection of Object.values(state.connections)) {
    if (
      connection.collectiveId === collectiveId &&
      connection.authorizedHumanId === humanId &&
      connection.status === 'connected'
    ) {
      connection.status = 'revoked';
      connection.revokedAt = leftAt;
      connection.revocationReason = 'membership_left';
    }
  }
}

function requireNoMemberArtifactCustody(state: ServiceState, collectiveId: string, humanId: string) {
  for (const connection of Object.values(state.connections))
    if (connection.collectiveId === collectiveId && connection.authorizedHumanId === humanId)
      requireNoArtifactCustody(state, connection.connectionId);
}

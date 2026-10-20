import { CollectiveServiceError } from './errors.js';
import { requireHumanAuthBinding, resolveSession } from './identity-store.js';
import { projectMembershipLeaveReadiness } from './membership-leave-readiness.js';
import type { PersistentServiceState } from './persistence.js';
import type { MembershipRecord } from './service-records.js';
import { type MutableServiceState, membershipKey } from './state.js';

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
    const readiness = projectMembershipLeaveReadiness(state, input.collectiveId, human.humanId);
    if (readiness.governanceHandoffRequired) {
      throw new CollectiveServiceError(
        'MEMBERSHIP_HANDOFF_REQUIRED',
        'A Collective steward must hand off governance before leaving',
        409,
      );
    }
    if (readiness.responsibilities.artifacts.items.length || readiness.responsibilities.artifacts.inaccessibleCount) {
      throw new CollectiveServiceError(
        'ARTIFACT_CUSTODY_HANDOFF_REQUIRED',
        'Settle pending publications and hand off shared work custody before leaving',
        409,
      );
    }
    if (readiness.responsibilities.works.length || readiness.responsibilities.roadmaps.length) {
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

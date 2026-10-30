import { CollectiveServiceError } from './errors.js';
import { requireHumanAuthBinding, resolveSession } from './identity-session.js';
import { requireSteward } from './membership-authority.js';
import { projectMemberDirectory, projectParticipants } from './member-projection.js';
import { type PersistentServiceState, secretMatches } from './persistence.js';
import type { InviteRecord, ServiceState } from './state.js';

/** The invitation secret grants a read-only preview, never membership or a session. */
export function previewInvite(persistence: PersistentServiceState, now: number, inviteToken: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(inviteToken)) return { status: 'invalid' as const };
  const state = persistence.snapshot();
  const invite = Object.values(state.invites).find((candidate) => secretMatches(inviteToken, candidate.tokenDigest));
  const collective = invite && state.collectives[invite.collectiveId];
  if (!invite || !collective) return { status: 'invalid' as const };
  const status = inviteStatus(invite, now);
  const inviter = invite.createdByHumanId ? state.humans[invite.createdByHumanId] : undefined;
  const memberCount = status === 'ready' ? countVisibleMembers(state, invite.collectiveId) : undefined;
  return {
    status,
    ...(memberCount !== undefined ? { memberCount } : {}),
    serviceInstanceId: state.serviceInstanceId,
    collective: { collectiveId: collective.collectiveId, name: collective.name },
    inviter: inviter ? { humanId: inviter.humanId, displayName: inviter.displayName } : null,
    expiresAt: invite.expiresAt,
  };
}

function inviteStatus(invite: InviteRecord, now: number) {
  return invite.revokedAt ? 'revoked' as const : invite.consumedAt ? 'used' as const
    : Date.parse(invite.expiresAt) < now ? 'expired' as const : 'ready' as const;
}

/** Only a steward can read the management list; it never returns invitation secrets or digests. */
export function listInvites(
  persistence: PersistentServiceState,
  now: number,
  input: { sessionToken: string; collectiveId: string; limit: number; cursor?: string },
) {
  const state = persistence.snapshot();
  const { human } = resolveSession(state, input.sessionToken);
  requireHumanAuthBinding(state, human.humanId);
  requireSteward(state, input.collectiveId, human.humanId);
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new CollectiveServiceError('FORBIDDEN', 'limit must be between 1 and 100', 400);
  }
  const sorted = Object.values(state.invites)
    .filter((invite) => invite.collectiveId === input.collectiveId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.inviteId.localeCompare(a.inviteId));
  const start = input.cursor ? sorted.findIndex((invite) => invite.inviteId === input.cursor) + 1 : 0;
  if (input.cursor && start === 0) throw new CollectiveServiceError('INVITE_INVALID', 'Invalid invitation cursor', 400);
  const page = sorted.slice(start, start + input.limit);
  return {
    invites: page.map((invite) => {
      const inviter = invite.createdByHumanId ? state.humans[invite.createdByHumanId] : undefined;
      return {
        inviteId: invite.inviteId,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
        status: inviteStatus(invite, now),
        inviter: inviter ? { humanId: inviter.humanId, displayName: inviter.displayName } : null,
      };
    }),
    ...(start + page.length < sorted.length ? { nextCursor: page.at(-1)?.inviteId } : {}),
  };
}

export async function revokeInvite(
  persistence: PersistentServiceState,
  now: () => number,
  input: { sessionToken: string; collectiveId: string; inviteId: string },
) {
  return persistence.transaction((state) => {
    const auth = resolveSession(state, input.sessionToken);
    requireHumanAuthBinding(state, auth.human.humanId);
    requireSteward(state, input.collectiveId, auth.human.humanId);
    const invite = state.invites[input.inviteId];
    if (!invite || invite.collectiveId !== input.collectiveId) {
      throw new CollectiveServiceError('INVITE_INVALID', 'Invite is invalid', 404);
    }
    if (invite.consumedAt) return { status: 'used' as const };
    if (!invite.revokedAt) invite.revokedAt = new Date(now()).toISOString();
    return { status: 'revoked' as const };
  });
}

function countVisibleMembers(state: ServiceState, collectiveId: string): number {
  const members = projectMemberDirectory(state, collectiveId);
  const connectedCafes = new Set(members.cafes.map((cafe) => cafe.connectionId));
  const cats = projectParticipants(state, collectiveId).filter(
    (cat) => cat.availability === 'declared' && connectedCafes.has(cat.connectionId),
  );
  return members.humans.length + cats.length;
}

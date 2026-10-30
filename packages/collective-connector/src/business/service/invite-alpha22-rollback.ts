import { z } from 'zod';
import { parseServiceState, type MutableServiceState } from './state.js';

// Keep this private metadata beside a rollback copy, never in the older Service's state file.
const rollbackMetadataSchema = z.object({
  version: z.literal(1),
  target: z.literal('0.1.0-alpha.22'),
  serviceInstanceId: z.string().min(1),
  invites: z.array(z.object({
    inviteId: z.string().min(1),
    collectiveId: z.string().min(1),
    tokenDigest: z.string().min(1),
    createdByHumanId: z.string().optional(),
    revokedAt: z.string().datetime().optional(),
  }).strict()),
}).strict();

type RollbackMetadata = z.infer<typeof rollbackMetadataSchema>;

/** Produce an offline copy. This function does not write files or stop/change a Service. */
export function prepareAlpha22InviteRollback(value: unknown): { state: MutableServiceState; metadata: RollbackMetadata } {
  const state = structuredClone(parseServiceState(value)) as MutableServiceState;
  const invites: RollbackMetadata['invites'] = [];
  for (const invite of Object.values(state.invites)) {
    if (invite.createdByHumanId !== undefined || invite.revokedAt !== undefined) {
      invites.push({
        inviteId: invite.inviteId,
        collectiveId: invite.collectiveId,
        tokenDigest: invite.tokenDigest,
        ...(invite.createdByHumanId !== undefined ? { createdByHumanId: invite.createdByHumanId } : {}),
        ...(invite.revokedAt !== undefined ? { revokedAt: invite.revokedAt } : {}),
      });
    }
    // Alpha22 treats consumed invitations as unavailable. Preserve that denial after removing the newer field.
    if (invite.revokedAt && !invite.consumedAt) invite.consumedAt = invite.revokedAt;
    delete invite.createdByHumanId;
    delete invite.revokedAt;
  }
  return { state, metadata: { version: 1, target: '0.1.0-alpha.22', serviceInstanceId: state.serviceInstanceId, invites } };
}

/** Reapply saved metadata to the current, independently advanced state; refuse mismatched identities. */
export function restoreInviteMetadata(value: unknown, unsafeMetadata: unknown): MutableServiceState {
  const state = structuredClone(parseServiceState(value)) as MutableServiceState;
  const metadata = rollbackMetadataSchema.parse(unsafeMetadata);
  if (state.serviceInstanceId !== metadata.serviceInstanceId) throw new Error('Rollback metadata belongs to another Service');
  const seen = new Set<string>();
  for (const saved of metadata.invites) {
    const invite = state.invites[saved.inviteId];
    if (seen.has(saved.inviteId) || !invite || invite.collectiveId !== saved.collectiveId || invite.tokenDigest !== saved.tokenDigest) {
      throw new Error('Rollback invitation identity does not match the current state');
    }
    if (
      (invite.createdByHumanId !== undefined && invite.createdByHumanId !== saved.createdByHumanId) ||
      (invite.revokedAt !== undefined && invite.revokedAt !== saved.revokedAt)
    ) throw new Error('Rollback invitation metadata conflicts with the current state');
    seen.add(saved.inviteId);
    if (saved.createdByHumanId !== undefined) invite.createdByHumanId = saved.createdByHumanId;
    if (saved.revokedAt !== undefined) invite.revokedAt = saved.revokedAt;
  }
  return parseServiceState(state) as MutableServiceState;
}

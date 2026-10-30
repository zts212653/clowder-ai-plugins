import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareAlpha22InviteRollback, restoreInviteMetadata } from '../invite-alpha22-rollback.js';
import { participationFixture } from './participation-fixture.js';

it('prepares an old-reader snapshot without reactivating revoked invitations and restores metadata after rollback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'invite-rollback-'));
  try {
    const f = await participationFixture(directory);
    const ready = await f.store.createInvite({ sessionToken: f.owner.sessionToken, collectiveId: f.coordinates.collectiveId });
    const revoked = await f.store.createInvite({ sessionToken: f.owner.sessionToken, collectiveId: f.coordinates.collectiveId });
    await f.store.revokeInvite({ sessionToken: f.owner.sessionToken, collectiveId: f.coordinates.collectiveId, inviteId: revoked.inviteId });
    const original = JSON.parse(await readFile(join(directory, 'collective-service.json'), 'utf8'));
    const originalCopy = structuredClone(original);
    const prepared = prepareAlpha22InviteRollback(original);
    expect(original).toEqual(originalCopy);
    expect(prepared.state.invites[ready.inviteId]).not.toHaveProperty('createdByHumanId');
    expect(prepared.state.invites[revoked.inviteId]).not.toHaveProperty('revokedAt');
    expect(prepared.state.invites[revoked.inviteId].consumedAt).toBe(original.invites[revoked.inviteId].revokedAt);
    expect(prepared.state.invites[ready.inviteId].consumedAt).toBeUndefined();

    // The older release may advance state while running; restoration must not replace that state with a stale backup.
    prepared.state.invites[ready.inviteId].consumedAt = '2026-10-30T01:00:00.000Z';
    const restored = restoreInviteMetadata(prepared.state, prepared.metadata);
    expect(restored.invites[ready.inviteId].consumedAt).toBe('2026-10-30T01:00:00.000Z');
    expect(restored.invites[ready.inviteId].createdByHumanId).toBe(f.owner.human.humanId);
    expect(restored.invites[revoked.inviteId].revokedAt).toBe(original.invites[revoked.inviteId].revokedAt);
    expect(restored.invites[revoked.inviteId].consumedAt).toBe(original.invites[revoked.inviteId].revokedAt);
    expect(restored.events).toEqual(prepared.state.events);
    const wrongState = structuredClone(prepared.state);
    wrongState.invites[ready.inviteId].tokenDigest = 'f'.repeat(64);
    expect(() => restoreInviteMetadata(wrongState, prepared.metadata)).toThrow();
    const alreadyChanged = structuredClone(prepared.state);
    alreadyChanged.invites[ready.inviteId].createdByHumanId = 'human_conflicting';
    expect(() => restoreInviteMetadata(alreadyChanged, prepared.metadata)).toThrow();
  } finally {
    await rm(directory, { recursive: true });
  }
});

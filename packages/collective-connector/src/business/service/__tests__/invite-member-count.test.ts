import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startCollectiveServer } from '../http-server.js';
import { participationFixture } from './participation-fixture.js';

it('previews the same people and connected cats visible in the Collective, only for a ready invite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'invite-member-count-'));
  let server: Awaited<ReturnType<typeof startCollectiveServer>> | undefined;
  try {
    const f = await participationFixture(directory);
    const other = await f.pair();
    for (const connection of [f.connection, other]) {
      await f.store.publishParticipation(connection.endpointCredential, {
        ...f.coordinates,
        connectionId: connection.connectionId,
        revision: 1,
        agents: [{ catId: 'same-cat-id', displayName: 'Cat', channelIds: ['a'] }],
      });
    }
    const invite = await f.store.createInvite({
      sessionToken: f.owner.sessionToken, collectiveId: f.coordinates.collectiveId,
    });
    server = await startCollectiveServer({ store: f.store, port: 0 });
    const post = async (token: string) => {
      const response = await fetch(`${server?.url}/api/invites/preview`, {
        method: 'POST',
        headers: { origin: server?.url ?? '', 'content-type': 'application/json' },
        body: JSON.stringify({ inviteToken: token }),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ status: string; memberCount?: number }>;
    };
    const visibleMemberCount = () => {
      const members = f.store.listMembers(f.owner.sessionToken, f.coordinates.collectiveId);
      const participants = f.store.listParticipants(f.owner.sessionToken, f.coordinates.collectiveId);
      return members.humans.length + participants.filter((cat) =>
        cat.availability === 'declared' && members.cafes.some((cafe) => cafe.connectionId === cat.connectionId),
      ).length;
    };
    expect(visibleMemberCount()).toBe(3);
    expect(await post(invite.inviteToken)).toMatchObject({ status: 'ready', memberCount: visibleMemberCount() });
    await f.store.revokeConnection({
      sessionToken: f.owner.sessionToken, collectiveId: f.coordinates.collectiveId, connectionId: other.connectionId,
    });
    expect(visibleMemberCount()).toBe(2);
    expect(await post(invite.inviteToken)).toMatchObject({ status: 'ready', memberCount: visibleMemberCount() });
    await f.store.revokeInvite({
      sessionToken: f.owner.sessionToken, collectiveId: f.coordinates.collectiveId, inviteId: invite.inviteId,
    });
    expect(await post(invite.inviteToken)).not.toHaveProperty('memberCount');
    expect(await post('unknown-invite-secret')).not.toHaveProperty('memberCount');
  } finally {
    await server?.close();
    await rm(directory, { recursive: true });
  }
});

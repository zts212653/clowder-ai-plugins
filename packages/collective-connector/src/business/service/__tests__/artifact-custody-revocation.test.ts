import { expect, it } from 'vitest';
import { artifactFixture } from './artifact.fixture.js';

it('requires handoff before either steward or endpoint revoke can strand a canonical owner', async () => {
  const f = await artifactFixture();
  await f.store.registerArtifact(f.connection.endpointCredential, f.registration);
  await expect(
    f.store.revokeConnection({
      sessionToken: f.owner.sessionToken,
      collectiveId: f.coordinates.collectiveId,
      connectionId: f.connection.connectionId,
    }),
  ).rejects.toMatchObject({ code: 'ARTIFACT_CUSTODY_HANDOFF_REQUIRED' });
  await expect(
    f.store.revokeOwnConnection(f.connection.endpointCredential, {
      ...f.coordinates,
      connectionId: f.connection.connectionId,
    }),
  ).rejects.toMatchObject({ code: 'ARTIFACT_CUSTODY_HANDOFF_REQUIRED' });
  expect(f.store.listArtifacts(f.member.sessionToken, f.coordinates)[0]?.availability).toBe('available');
});

it('does not strand a legacy retained owner that has not installed its narrow continuity capability', async () => {
  const f = await artifactFixture();
  const input = { ...f.registration, mediaType: 'image/png' as const };
  await f.store.registerArtifact(f.connection.endpointCredential, input);
  await expect(
    f.store.revokeConnection({
      sessionToken: f.owner.sessionToken,
      collectiveId: f.coordinates.collectiveId,
      connectionId: f.connection.connectionId,
    }),
  ).rejects.toMatchObject({ code: 'ARTIFACT_CUSTODY_HANDOFF_REQUIRED' });
  expect(await f.store.recoverMediaCustody(f.connection.endpointCredential, input)).toEqual({ status: 'current' });
  expect(
    await f.store.revokeConnection({
      sessionToken: f.owner.sessionToken,
      collectiveId: f.coordinates.collectiveId,
      connectionId: f.connection.connectionId,
    }),
  ).toMatchObject({ status: 'revoked' });
});

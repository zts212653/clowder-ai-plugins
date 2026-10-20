import { expect, it } from 'vitest';
import { CollectiveServiceStore } from '../store.js';
import { artifactFixture } from './artifact.fixture.js';

async function destinationFixture() {
  const f = await artifactFixture();
  const artifact = (await f.post('/api/artifacts/register', f.connection.endpointCredential, f.registration)).value
    .artifact;
  const targets = [];
  for (const endpointLabel of ['Studio Café', 'Travel Café']) {
    const pair = await f.store.createPairingIntent({
      sessionToken: f.member.sessionToken,
      collectiveId: f.coordinates.collectiveId,
      hostOrigin: 'http://localhost:5183',
      nonce: `destination-${endpointLabel}`,
    });
    targets.push(await f.store.exchangePairingIntent({ ...pair, endpointLabel }));
  }
  const input = {
    ...f.coordinates,
    artifactId: artifact.artifactId,
    targetHumanId: f.member.human.humanId,
    expectedCustodyRevision: 1,
    requestId: 'explicit-destination',
  };
  return { ...f, artifact, targets, input };
}

it('requires an explicit Cafe when a Human has two, then preserves that exact destination across replay and Service reopen', async () => {
  const f = await destinationFixture();
  const management = f.store.readArtifactManagement(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
  });
  expect(management.members.find((member) => member.humanId === f.member.human.humanId)?.canReceiveCustody).toBe(true);
  expect(management.custodianCafe).toEqual({
    connectionId: f.connection.connectionId,
    endpointLabel: 'Editable label',
  });
  expect((await f.post('/api/artifacts/custody/offer', f.owner.sessionToken, f.input)).status).toBe(409);
  const input = { ...f.input, targetConnectionId: f.targets[1].connectionId };
  const offered = await f.post('/api/artifacts/custody/offer', f.owner.sessionToken, input);
  expect(offered.status).toBe(201);
  const transferInput = { ...f.coordinates, artifactId: f.artifact.artifactId, transferId: offered.value.handoffRef };
  const transfer = f.store.readArtifactCustody(f.targets[1].endpointCredential, {
    ...transferInput,
    connectionId: f.targets[1].connectionId,
  });
  expect(transfer).toMatchObject({
    targetConnectionId: f.targets[1].connectionId,
    targetHumanId: f.member.human.humanId,
  });
  const reopened = (
    await CollectiveServiceStore.open({ dataDirectory: f.directory, humanAuthProvider: f.humanAuthProvider })
  ).store;
  expect(await reopened.offerArtifactCustody(f.owner.sessionToken, input)).toEqual(offered.value);
  await expect(
    reopened.offerArtifactCustody(f.owner.sessionToken, {
      ...input,
      targetConnectionId: f.targets[0].connectionId,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
});

it('does not reroute an explicit disconnected Cafe to another one or accept a Cafe owned by another Human', async () => {
  const f = await destinationFixture();
  const stalePage = f.store.readArtifactManagement(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    limit: 1,
  });
  await f.store.revokeConnection({
    sessionToken: f.owner.sessionToken,
    collectiveId: f.coordinates.collectiveId,
    connectionId: f.targets[1].connectionId,
  });
  for (const targetConnectionId of [f.targets[1].connectionId, f.connection.connectionId, 'unknown-cafe']) {
    expect(
      (
        await f.post('/api/artifacts/custody/offer', f.owner.sessionToken, {
          ...f.input,
          targetConnectionId,
          requestId: `reject-${targetConnectionId}`,
        })
      ).status,
    ).toBe(409);
  }
  expect(() =>
    f.store.readArtifactManagement(f.owner.sessionToken, {
      ...f.coordinates,
      artifactId: f.artifact.artifactId,
      offset: 1,
      limit: 1,
      snapshot: stalePage.snapshot,
    }),
  ).toThrow('Management changed');
  expect(
    f.store.readArtifactManagement(f.owner.sessionToken, {
      ...f.coordinates,
      artifactId: f.artifact.artifactId,
    }).transfer,
  ).toBeUndefined();
  expect(
    (
      await f.post('/api/artifacts/custody/offer', f.owner.sessionToken, {
        ...f.input,
        targetConnectionId: f.targets[0].connectionId,
      })
    ).status,
  ).toBe(201);
});

it('rechecks destination read permission rather than trusting the previously displayed Cafe choice', async () => {
  const f = await destinationFixture();
  await f.store.updateArtifactAccess(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    humanId: f.member.human.humanId,
    expectedAccessRevision: 1,
    access: 'revoked',
    requestId: 'revoke-before-offer',
  });
  expect(
    (
      await f.post('/api/artifacts/custody/offer', f.owner.sessionToken, {
        ...f.input,
        targetConnectionId: f.targets[0].connectionId,
      })
    ).status,
  ).toBe(403);
});

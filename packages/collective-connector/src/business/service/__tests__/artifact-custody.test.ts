import { expect, it } from 'vitest';
import { artifactFixture as fixture } from './artifact.fixture.js';

it('rejects an empty target that copies the directory tuple without prepared and ready owner proofs', async () => {
  const f = await fixture();
  const published = await f.post('/api/artifacts/register', f.connection.endpointCredential, f.registration);
  const pairing = await f.store.createPairingIntent({
    sessionToken: f.member.sessionToken,
    collectiveId: f.coordinates.collectiveId,
    hostOrigin: 'http://localhost:5183',
    nonce: 'empty-custodian-nonce',
  });
  const target = await f.store.exchangePairingIntent({ ...pairing, endpointLabel: 'Empty Café' });
  const artifactId = published.value.artifact.artifactId;
  const offer = await f.post('/api/artifacts/custody/offer', f.owner.sessionToken, {
    ...f.coordinates,
    artifactId,
    expectedCustodyRevision: 1,
    targetHumanId: f.member.human.humanId,
    requestId: 'empty-offer',
  });
  const accepted = await f.post('/api/artifacts/custody/accept', target.endpointCredential, {
    ...f.coordinates,
    connectionId: target.connectionId,
    artifactId,
    handoffRef: offer.value.handoffRef,
    expectedCustodyRevision: 1,
    contentRef: f.registration.contentRef,
    ownerRevision: 1,
    blobDigest: f.registration.blobDigest,
    receiptRef: f.registration.receiptRef,
    ownerScopeRef: 'copied-unverified-scope',
    requestId: 'empty-target-accept',
  });
  expect(accepted.status).toBe(409);
  expect(accepted.value.error.code).toBe('ARTIFACT_CUSTODY_HANDOFF_REQUIRED');
  expect(
    (
      await f.post('/api/artifacts/constraints', f.owner.sessionToken, {
        ...f.coordinates,
        artifactId,
        sourceEventId: f.source.eventId,
        action: 'read',
      })
    ).status,
  ).toBe(201);
});

it('does not disclose custodian coordinates and preserves another member decision after a resource revoke', async () => {
  const f = await fixture();
  const publication = await f.post('/api/artifacts/register', f.connection.endpointCredential, f.registration);
  const artifact = publication.value.artifact;
  const input = { ...f.coordinates, artifactId: artifact.artifactId, sourceEventId: f.source.eventId, action: 'read' };
  const other = await f.post('/api/artifacts/constraints', f.owner.sessionToken, input);
  expect(other.status).toBe(201);
  expect(other.value.constraint).not.toHaveProperty('ownerConnectionId');
  expect(artifact).not.toHaveProperty('ownerConnectionId');
  expect(artifact).not.toHaveProperty('custody');
  expect(artifact.publishedByHumanId).toBe(f.owner.human.humanId);
  await f.post('/api/artifacts/access/revoke', f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: artifact.artifactId,
    humanId: f.member.human.humanId,
    expectedAccessRevision: 1,
    requestId: 'revoke-member',
  });
  const checked = await f.post('/api/artifacts/constraints/validate', f.connection.endpointCredential, {
    ...input,
    connectionId: f.connection.connectionId,
    decisionRef: other.value.constraint.decisionRef,
  });
  expect(checked.status).toBe(200);
  expect(checked.value.constraint).toEqual(other.value.constraint);
});

it('keeps an unavailable retained-media custodian in the directory and fences its old session', async () => {
  const f = await fixture();
  const published = await f.post('/api/artifacts/register', f.connection.endpointCredential, {
    ...f.registration,
    mediaType: 'image/png',
  });
  await f.store.recoverMediaCustody(f.connection.endpointCredential, { ...f.registration, mediaType: 'image/png' });
  const input = {
    ...f.coordinates,
    artifactId: published.value.artifact.artifactId,
    sourceEventId: f.source.eventId,
    action: 'read',
  };
  const old = await f.post('/api/artifacts/constraints', f.member.sessionToken, input);
  await f.store.revokeConnection({
    sessionToken: f.owner.sessionToken,
    collectiveId: f.coordinates.collectiveId,
    connectionId: f.connection.connectionId,
  });
  const directory = await f.post('/api/artifacts/list', f.member.sessionToken, f.coordinates);
  expect(directory.status).toBe(200);
  expect(directory.value.artifacts).toHaveLength(1);
  expect(directory.value.artifacts[0]).toMatchObject({
    artifactId: input.artifactId,
    availability: 'owner_unavailable',
  });
  const read = await f.post('/api/artifacts/constraints', f.member.sessionToken, input);
  expect(read.status).toBe(503);
  expect(read.value.error.code).toBe('ARTIFACT_OWNER_UNAVAILABLE');
  expect(
    (
      await f.post('/api/artifacts/constraints/validate', f.connection.endpointCredential, {
        ...input,
        connectionId: f.connection.connectionId,
        decisionRef: old.value.constraint.decisionRef,
      })
    ).status,
  ).not.toBe(200);
});

it('grants and withdraws actual apply permission without invalidating unrelated readers', async () => {
  const f = await fixture();
  const published = await f.post('/api/artifacts/register', f.connection.endpointCredential, f.registration);
  const artifactId = published.value.artifact.artifactId;
  const base = { ...f.coordinates, artifactId, sourceEventId: f.source.eventId };
  expect((await f.post('/api/artifacts/constraints', f.member.sessionToken, { ...base, action: 'apply' })).status).toBe(
    403,
  );
  expect(
    (
      await f.post('/api/artifacts/access/update', f.member.sessionToken, {
        ...f.coordinates,
        artifactId,
        humanId: f.member.human.humanId,
        expectedAccessRevision: 1,
        requestId: 'self-grant',
        access: 'apply',
      })
    ).status,
  ).toBe(403);
  const granted = await f.post('/api/artifacts/access/update', f.owner.sessionToken, {
    ...f.coordinates,
    artifactId,
    humanId: f.member.human.humanId,
    expectedAccessRevision: 1,
    requestId: 'grant-apply',
    access: 'apply',
  });
  expect(granted.status).toBe(200);
  expect((await f.post('/api/artifacts/constraints', f.member.sessionToken, { ...base, action: 'apply' })).status).toBe(
    201,
  );
  for (const action of ['read', 'history', 'annotate', 'propose', 'preview']) {
    expect((await f.post('/api/artifacts/constraints', f.member.sessionToken, { ...base, action })).status).toBe(201);
  }
});

it('requires verified custody handoff before a custodian leaves, and fences the old endpoint after handoff', async () => {
  const f = await fixture();
  const pair = await f.store.createPairingIntent({
    sessionToken: f.member.sessionToken,
    collectiveId: f.coordinates.collectiveId,
    hostOrigin: 'http://localhost:5183',
    nonce: 'member-custodian-nonce',
  });
  const memberConnection = await f.store.exchangePairingIntent({ ...pair, endpointLabel: 'Second Café' });
  const initial = await f.post('/api/artifacts/register', memberConnection.endpointCredential, {
    ...f.registration,
    connectionId: memberConnection.connectionId,
  });
  const artifact = initial.value.artifact;
  await expect(
    f.store.leaveCollective({ sessionToken: f.member.sessionToken, collectiveId: f.coordinates.collectiveId }),
  ).rejects.toMatchObject({ code: 'ARTIFACT_CUSTODY_HANDOFF_REQUIRED' });
  const offer = await f.post('/api/artifacts/custody/offer', f.member.sessionToken, {
    ...f.coordinates,
    artifactId: artifact.artifactId,
    expectedCustodyRevision: 1,
    targetHumanId: f.owner.human.humanId,
    requestId: 'handoff-offer',
  });
  expect(offer.status).toBe(201);
  const receipt = {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    artifactId: artifact.artifactId,
    handoffRef: offer.value.handoffRef,
    expectedCustodyRevision: 1,
    contentRef: f.registration.contentRef,
    ownerRevision: 1,
    blobDigest: f.registration.blobDigest,
    receiptRef: f.registration.receiptRef,
    ownerScopeRef: 'owner-scope:verified-by-owner',
    preparedRef: 'owner-prepared:shared-work',
    readyRef: 'owner-ready:shared-work',
    requestId: 'handoff-verified',
  };
  expect((await f.post('/api/artifacts/custody/accept', memberConnection.endpointCredential, receipt)).status).toBe(
    401,
  );
  const proof = {
    preparedRef: receipt.preparedRef,
    ownerScopeRef: receipt.ownerScopeRef,
    version: {
      contentRef: receipt.contentRef,
      ownerRevision: receipt.ownerRevision,
      blobDigest: receipt.blobDigest,
      receiptRef: receipt.receiptRef,
    },
    manifest: { digest: `sha256:${'b'.repeat(64)}`, totalBytes: 1000, pageCount: 1 },
  };
  expect(
    (
      await f.post('/api/artifacts/custody/prepared', memberConnection.endpointCredential, {
        ...f.coordinates,
        connectionId: memberConnection.connectionId,
        artifactId: artifact.artifactId,
        transferId: offer.value.handoffRef,
        proof,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await f.post('/api/artifacts/custody/ready', f.connection.endpointCredential, {
        ...f.coordinates,
        connectionId: f.connection.connectionId,
        artifactId: artifact.artifactId,
        transferId: offer.value.handoffRef,
        proof: {
          readyRef: receipt.readyRef,
          preparedRef: proof.preparedRef,
          manifestDigest: proof.manifest.digest,
          ownerScopeRef: proof.ownerScopeRef,
        },
      })
    ).status,
  ).toBe(200);
  const accepted = await f.post('/api/artifacts/custody/accept', f.connection.endpointCredential, receipt);
  expect(accepted.status).toBe(200);
  expect(accepted.value.artifact.artifactId).toBe(artifact.artifactId);
  await f.store.finalizeArtifactCustody(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    artifactId: artifact.artifactId,
    transferId: offer.value.handoffRef,
    outcome: 'committed',
  });
  const retired = await f.post('/api/artifacts/register', memberConnection.endpointCredential, {
    ...f.registration,
    connectionId: memberConnection.connectionId,
    expectedRevision: 1,
    expectedCustodyRevision: 2,
    ownerRevision: 2,
    requestId: 'retired-endpoint-before-leave',
  });
  expect(retired.status).toBe(403);
  await f.store.leaveCollective({ sessionToken: f.member.sessionToken, collectiveId: f.coordinates.collectiveId });
  const entry = (await f.post('/api/artifacts/list', f.owner.sessionToken, f.coordinates)).value.artifacts[0];
  expect(entry.publishedByHumanId).toBe(f.member.human.humanId);
  expect(entry.availability).toBe('available');
  const invalidOldPublication = await f.post('/api/artifacts/register', memberConnection.endpointCredential, {
    ...f.registration,
    connectionId: memberConnection.connectionId,
    expectedRevision: 1,
    ownerRevision: 2,
    requestId: 'old-custodian-publish',
  });
  expect(invalidOldPublication.status).not.toBe(201);
});

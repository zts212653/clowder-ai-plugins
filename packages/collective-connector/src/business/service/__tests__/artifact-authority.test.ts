import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startCollectiveServer } from '../http-server.js';
import { CollectiveServiceStore } from '../store.js';
import { artifactFixture as fixture, servers } from './artifact.fixture.js';

it('binds independent authenticated Humans to one owner version and exact source without storing bytes', async () => {
  const f = await fixture();
  const registered = await f.post('/api/artifacts/register', f.connection.endpointCredential, f.registration);
  expect(registered.status).toBe(201);
  const artifact = registered.value.artifact;
  const input = { ...f.coordinates, artifactId: artifact.artifactId, sourceEventId: f.source.eventId, action: 'read' };
  const first = await f.post('/api/artifacts/constraints', f.owner.sessionToken, input);
  const second = await f.post('/api/artifacts/constraints', f.member.sessionToken, input);
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  expect(first.value.constraint.humanId).not.toBe(second.value.constraint.humanId);
  for (const result of [first, second]) {
    expect(result.value.constraint).toMatchObject({
      ...f.coordinates,
      contentRef: f.registration.contentRef,
      ownerRevision: 1,
      blobDigest: f.registration.blobDigest,
      action: 'read',
      sourceEventId: f.source.eventId,
    });
    expect(typeof result.value.constraint.decisionRef).toBe('string');
  }
  expect(
    (await f.post('/api/artifacts/constraints', f.member.sessionToken, { ...input, humanId: f.owner.human.humanId }))
      .status,
  ).toBe(400);
  expect(
    (await f.post('/api/artifacts/constraints', f.member.sessionToken, { ...input, sourceEventId: 'wrong-source' }))
      .status,
  ).toBe(403);
  expect(
    (await f.post('/api/artifacts/constraints', f.member.sessionToken, { ...input, collectiveId: 'wrong-collective' }))
      .status,
  ).toBe(409);
  expect((await f.post('/api/artifacts/register', f.member.sessionToken, f.registration)).status).toBe(401);
  expect(
    (
      await f.post('/api/artifacts/register', f.connection.endpointCredential, {
        ...f.registration,
        bytes: '# private text',
      })
    ).status,
  ).toBe(400);
  const persisted = await readFile(join(f.directory, 'collective-service.json'), 'utf8');
  expect(persisted).not.toContain(first.value.constraint.decisionRef);
  expect(persisted).not.toContain('private text');
});

it('fresh-validates old decisions after revoke, leave and restart while another member remains authorized', async () => {
  const f = await fixture();
  const registered = await f.post('/api/artifacts/register', f.connection.endpointCredential, f.registration);
  expect(registered.status).toBe(201);
  const artifactId = registered.value.artifact.artifactId;
  const input = { ...f.coordinates, artifactId, sourceEventId: f.source.eventId, action: 'read' };
  const issued = await f.post('/api/artifacts/constraints', f.member.sessionToken, input);
  const validation = {
    ...input,
    connectionId: f.connection.connectionId,
    decisionRef: issued.value.constraint.decisionRef,
  };
  expect(
    (await f.post('/api/artifacts/constraints/validate', f.connection.endpointCredential, validation)).status,
  ).toBe(200);
  const revoked = await f.post('/api/artifacts/access/revoke', f.owner.sessionToken, {
    ...f.coordinates,
    artifactId,
    humanId: f.member.human.humanId,
    expectedAccessRevision: 1,
    requestId: 'revoke-member',
  });
  expect(revoked.status).toBe(200);
  expect(
    (await f.post('/api/artifacts/constraints/validate', f.connection.endpointCredential, validation)).status,
  ).toBe(403);
  expect((await f.post('/api/artifacts/constraints', f.member.sessionToken, input)).status).toBe(403);
  expect((await f.post('/api/artifacts/constraints', f.owner.sessionToken, input)).status).toBe(201);
  const reopened = await CollectiveServiceStore.open({
    dataDirectory: f.directory,
    humanAuthProvider: f.humanAuthProvider,
  });
  const restarted = await startCollectiveServer({ store: reopened.store, port: 0 });
  servers.push(restarted);
  const afterRestart = await fetch(`${restarted.url}/api/artifacts/constraints`, {
    method: 'POST',
    headers: { authorization: `Bearer ${f.member.sessionToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  expect(afterRestart.status).toBe(403);
  await f.store.leaveCollective({ sessionToken: f.member.sessionToken, collectiveId: f.coordinates.collectiveId });
  expect((await f.post('/api/artifacts/constraints', f.member.sessionToken, input)).status).toBe(403);
});

it('rejects expired decisions and mismatched owner, action or version on an otherwise valid decision', async () => {
  const f = await fixture();
  const registered = await f.post('/api/artifacts/register', f.connection.endpointCredential, f.registration);
  expect(registered.status).toBe(201);
  const input = {
    ...f.coordinates,
    artifactId: registered.value.artifact.artifactId,
    sourceEventId: f.source.eventId,
    action: 'read',
  };
  const issued = await f.post('/api/artifacts/constraints', f.member.sessionToken, input);
  const validation = {
    ...input,
    connectionId: f.connection.connectionId,
    decisionRef: issued.value.constraint.decisionRef,
  };
  expect(
    (
      await f.post('/api/artifacts/constraints/validate', f.connection.endpointCredential, {
        ...validation,
        action: 'apply',
      })
    ).status,
  ).toBe(403);
  expect((await f.post('/api/artifacts/constraints/validate', f.owner.sessionToken, validation)).status).toBe(401);
  expect(
    (
      await f.post('/api/artifacts/constraints/validate', f.connection.endpointCredential, {
        ...validation,
        ownerRevision: 2,
      })
    ).status,
  ).toBe(403);
  let now = Date.now();
  const reopened = await CollectiveServiceStore.open({ dataDirectory: f.directory, now: () => now });
  const expiring = reopened.store.issueArtifactConstraint(f.member.sessionToken, input);
  const expiringInput = { ...validation, decisionRef: expiring.decisionRef };
  expect(reopened.store.validateArtifactConstraint(f.connection.endpointCredential, expiringInput).humanId).toBe(
    f.member.human.humanId,
  );
  now += 30_001;
  expect(() => reopened.store.validateArtifactConstraint(f.connection.endpointCredential, expiringInput)).toThrowError(
    'Shared work access',
  );
});

it('keeps one directory entry with immutable owner version history and never accepts a stale publication', async () => {
  const f = await fixture();
  const first = await f.post('/api/artifacts/register', f.connection.endpointCredential, f.registration);
  expect(first.status).toBe(201);
  const v2 = {
    ...f.registration,
    expectedRevision: 1,
    expectedCustodyRevision: 1,
    ownerRevision: 2,
    blobDigest: `sha256:${'b'.repeat(64)}`,
    receiptRef: 'content-receipt:guide-v2',
    requestId: 'publish-guide-v2',
  };
  const second = await f.post('/api/artifacts/register', f.connection.endpointCredential, v2);
  expect(second.status).toBe(201);
  expect(second.value.artifact.artifactId).toBe(first.value.artifact.artifactId);
  const replay = await f.post('/api/artifacts/register', f.connection.endpointCredential, v2);
  expect(replay.value.artifact.versions).toHaveLength(1);
  expect(replay.value.artifact.versionCount).toBe(2);
  const catalogueHistory = await f.post('/api/artifacts/history', f.member.sessionToken, {
    ...f.coordinates,
    artifactId: first.value.artifact.artifactId,
    sourceEventId: f.source.eventId,
  });
  expect(catalogueHistory.status).toBe(200);
  expect(catalogueHistory.value.versions.map((version: { ownerRevision: number }) => version.ownerRevision)).toEqual([
    2, 1,
  ]);
  expect(
    (await f.post('/api/artifacts/register', f.connection.endpointCredential, { ...v2, requestId: 'stale-v2' })).status,
  ).toBe(409);
  const listing = await f.post('/api/artifacts/list', f.member.sessionToken, {
    ...f.coordinates,
    channelId: 'general',
  });
  expect(listing.status).toBe(200);
  expect(listing.value.artifacts).toHaveLength(1);
  expect(listing.value.artifacts[0]).toMatchObject({
    sourceEventId: f.source.eventId,
    revision: 2,
    versionCount: 2,
    versions: [{ ownerRevision: 2 }],
  });
  const history = await f.post('/api/artifacts/constraints', f.member.sessionToken, {
    ...f.coordinates,
    artifactId: first.value.artifact.artifactId,
    sourceEventId: f.source.eventId,
    action: 'read',
    ownerRevision: 1,
  });
  expect(history.status).toBe(201);
  expect(history.value.constraint.blobDigest).toBe(f.registration.blobDigest);
});

it('reports a stale content version as a recoverable conflict while preserving current read access', async () => {
  const f = await fixture();
  const first = await f.post('/api/artifacts/register', f.connection.endpointCredential, f.registration);
  const request = {
    ...f.coordinates,
    artifactId: first.value.artifact.artifactId,
    sourceEventId: f.source.eventId,
    action: 'apply',
    ownerRevision: 1,
  };
  const old = await f.post('/api/artifacts/constraints', f.owner.sessionToken, request);
  await f.post('/api/artifacts/register', f.connection.endpointCredential, {
    ...f.registration,
    expectedRevision: 1,
    expectedCustodyRevision: 1,
    ownerRevision: 2,
    blobDigest: `sha256:${'b'.repeat(64)}`,
    receiptRef: 'owner-receipt:v2',
    requestId: 'publish-second',
  });
  const stale = await f.post('/api/artifacts/constraints', f.owner.sessionToken, request);
  expect(stale.status).toBe(409);
  const staleDecision = await f.post('/api/artifacts/constraints/validate', f.connection.endpointCredential, {
    ...request,
    connectionId: f.connection.connectionId,
    decisionRef: old.value.constraint.decisionRef,
  });
  expect(staleDecision.status).toBe(409);
  const current = await f.post('/api/artifacts/constraints', f.owner.sessionToken, {
    ...request,
    action: 'read',
    ownerRevision: 2,
  });
  expect(current.status).toBe(201);
});

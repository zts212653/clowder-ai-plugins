import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CollectiveServiceStore } from '../store.js';
import { artifactFixture } from './artifact.fixture.js';

it('prepares an exact public Markdown publication only for the session Human and its paired Café, retaining no bytes', async () => {
  const f = await artifactFixture();
  const text = '# Shared publication\nPRIVATE-BYTES-ONLY-IN-OWNER\n';
  const input = {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    sourceEventId: f.source.eventId,
    requestId: 'human-file-publication',
    title: '共同接入指南',
    blobDigest: `sha256:${createHash('sha256').update(text).digest('hex')}`,
  };
  expect((await f.post('/api/artifacts/publications/prepare', f.member.sessionToken, input)).status).toBe(403);
  expect(
    (await f.post('/api/artifacts/publications/prepare', f.owner.sessionToken, { ...input, humanId: 'forged' })).status,
  ).toBe(400);
  const prepared = await f.post('/api/artifacts/publications/prepare', f.owner.sessionToken, input);
  expect(prepared.status).toBe(201);
  expect(prepared.value.publication).toMatchObject({ status: 'pending', sourceEventId: f.source.eventId });
  expect(JSON.stringify(prepared.value)).not.toContain(f.connection.endpointCredential);
  const replay = await f.post('/api/artifacts/publications/prepare', f.owner.sessionToken, input);
  expect(replay.value).toEqual(prepared.value);
  expect(
    (await f.post('/api/artifacts/publications/prepare', f.owner.sessionToken, { ...input, title: 'rebound' })).status,
  ).toBe(409);
  const reopened = await CollectiveServiceStore.open({
    dataDirectory: f.directory,
    humanAuthProvider: f.humanAuthProvider,
  });
  const restored = await reopened.store.prepareArtifactPublication(f.owner.sessionToken, input);
  expect(restored).toEqual(prepared.value.publication);
  const state = await readFile(join(f.directory, 'collective-service.json'), 'utf8');
  expect(state).not.toContain(text);
  expect(state).not.toContain(Buffer.from(text).toString('base64'));
});

it('reserves custody only after durable owner admission and releases an absent effect before disconnect', async () => {
  const f = await artifactFixture();
  const bytes = Buffer.from('# Admitted');
  const prepared = await f.store.prepareArtifactPublication(f.owner.sessionToken, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    sourceEventId: f.source.eventId,
    requestId: 'admission-reservation',
    title: 'Pending',
    blobDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  });
  const waiting = f.store
    .sendArtifactPublication(f.owner.sessionToken, {
      publicationId: prepared.publicationId,
      bytesBase64: bytes.toString('base64'),
    })
    .catch((error: unknown) => error);
  const operation = (
    await f.store.pollArtifactPublications(f.connection.endpointCredential, {
      ...f.coordinates,
      connectionId: f.connection.connectionId,
    })
  )[0];
  expect(operation).toBeTruthy();
  if (!operation) throw new Error('Expected original publication');
  await f.store.validateArtifactPublication(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    publicationId: prepared.publicationId,
    relayRef: operation.relayRef,
  });
  await expect(
    f.store.revokeConnection({
      sessionToken: f.owner.sessionToken,
      collectiveId: f.coordinates.collectiveId,
      connectionId: f.connection.connectionId,
    }),
  ).rejects.toMatchObject({ code: 'ARTIFACT_CUSTODY_HANDOFF_REQUIRED' });
  await f.store.recoverArtifactPublication(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    publicationId: prepared.publicationId,
    outcome: { status: 'absent' },
  });
  expect(
    await f.store.revokeConnection({
      sessionToken: f.owner.sessionToken,
      collectiveId: f.coordinates.collectiveId,
      connectionId: f.connection.connectionId,
    }),
  ).toMatchObject({ status: 'revoked' });
  f.store.stopArtifactOwnerRelay();
  expect(await waiting).toMatchObject({ code: 'ARTIFACT_OWNER_UNAVAILABLE' });
});

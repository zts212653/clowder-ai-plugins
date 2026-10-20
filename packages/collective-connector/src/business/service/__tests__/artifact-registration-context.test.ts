import { expect, it } from 'vitest';
import { artifactFixture } from './artifact.fixture.js';

it('resolves only the exact fresh registration snapshot and keeps replay and stale CAS distinct', async () => {
  const f = await artifactFixture();
  const credential = f.connection.endpointCredential;
  const first = { ...f.registration, mediaType: 'image/png' };
  const input = {
    ...f.coordinates,
    connectionId: first.connectionId,
    contentRef: first.contentRef,
    sourceEventId: first.sourceEventId,
    mediaType: first.mediaType,
  };
  const context = () => f.post('/api/artifacts/register/context', credential, input);
  expect((await context()).value).toEqual({ ...input, current: null });
  await f.store.registerArtifact(credential, first);
  const snapshot = await context();
  expect(snapshot).toEqual({ status: 200, value: { ...input, current: { revision: 1, custodyRevision: 1 } } });
  const second = {
    ...first,
    ownerRevision: 2,
    requestId: 'retained-v2',
    receiptRef: 'receipt-v2',
    expectedRevision: snapshot.value.current.revision,
    expectedCustodyRevision: snapshot.value.current.custodyRevision,
  };
  expect((await f.post('/api/artifacts/register', credential, second)).status).toBe(201);
  expect((await context()).value.current.revision).toBe(2);
  expect((await f.post('/api/artifacts/register', credential, second)).status).toBe(201);
  expect((await f.post('/api/artifacts/register', credential, { ...second, requestId: 'stale-v2' })).status).toBe(409);
  expect((await f.post('/api/artifacts/register/context', f.owner.sessionToken, input)).status).toBe(401);
  expect(
    (await f.post('/api/artifacts/register/context', credential, { ...input, mediaType: 'video/mp4' })).status,
  ).toBe(403);
  const other = await f.store.postHumanMessage(f.owner.sessionToken, {
    ...f.coordinates,
    clientEventId: 'other-discussion',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: 'Another source',
  });
  expect(
    (await f.post('/api/artifacts/register/context', credential, { ...input, sourceEventId: other.eventId })).status,
  ).toBe(403);
  const artifact = f.store.listArtifacts(f.owner.sessionToken, f.coordinates)[0];
  await f.store.updateArtifactAccess(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: artifact.artifactId,
    humanId: f.owner.human.humanId,
    expectedAccessRevision: 1,
    access: 'revoked',
    requestId: 'revoke-registration-reader',
  });
  expect((await context()).status).toBe(403);
  expect(f.store.listArtifacts(f.member.sessionToken, f.coordinates)[0]?.versionCount).toBe(2);
});

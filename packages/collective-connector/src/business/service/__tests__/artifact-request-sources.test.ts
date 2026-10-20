import { expect, it } from 'vitest';
import { CollectiveServiceStore } from '../store.js';
import { artifactFixture } from './artifact.fixture.js';
import { nextArtifactOperation } from './artifact-request.fixture.js';

it('publishes only source-bound Artifact references to the named Cat, fences old delegation epochs and persists no owner payload', async () => {
  const f = await artifactFixture();
  const published = await f.post('/api/artifacts/register', f.connection.endpointCredential, f.registration);
  const artifactId = published.value.artifact.artifactId;
  await f.store.publishParticipation(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    revision: 1,
    agents: [{ catId: 'codex61-sol', displayName: 'Sol', channelIds: ['general'] }],
  });
  const source = await f.store.postHumanMessage(f.member.sessionToken, {
    ...f.coordinates,
    clientEventId: 'ask-artifact',
    location: { channelId: 'general', rootEventId: f.source.eventId },
    recipient: {
      kind: 'agent',
      humanId: f.owner.human.humanId,
      agentId: 'codex61-sol',
      connectionId: f.connection.connectionId,
      participationRevision: 1,
    },
    body: '请改这份作品的选区。',
  });
  const pending = f.store.requestArtifactOperation(f.member.sessionToken, {
    ...f.coordinates,
    artifactId,
    sourceEventId: f.source.eventId,
    action: 'propose',
    requestId: 'ask-owner',
    payload: {
      kind: 'request-modification',
      messageEventId: source.eventId,
      annotationIds: ['real-owner-annotation'],
      expectedReviewRevision: 2,
    },
  });
  const poll = { ...f.coordinates, connectionId: f.connection.connectionId };
  const operation = await nextArtifactOperation(f.store, f.connection.endpointCredential, poll);
  f.store.respondArtifactOperation(f.connection.endpointCredential, {
    ...poll,
    relayRef: operation.relayRef,
    status: 'ok',
    ownerDecisionRef: 'owner-allow:request',
    value: { prepared: true },
  });
  await pending;
  const read = { ...poll, eventId: source.eventId, catId: 'codex61-sol', participationRevision: 1 };
  const context = await f.post('/api/artifacts/agent/context', f.connection.endpointCredential, read);
  expect(context.status).toBe(200);
  expect(context.value.requests).toEqual([
    {
      artifactId,
      title: f.registration.title,
      contentRef: f.registration.contentRef,
      sourceEventId: f.source.eventId,
      requestEventId: source.eventId,
      ownerRevision: 1,
      blobDigest: f.registration.blobDigest,
      annotationIds: ['real-owner-annotation'],
      expectedReviewRevision: 2,
    },
  ]);
  expect(JSON.stringify(context.value)).not.toContain(f.connection.connectionId);
  expect(JSON.stringify(context.value)).not.toContain(f.connection.endpointCredential);
  const reopened = await CollectiveServiceStore.open({
    dataDirectory: f.directory,
    humanAuthProvider: f.humanAuthProvider,
  });
  expect(reopened.store.readAgentArtifactContext(f.connection.endpointCredential, read)).toEqual(context.value);
  expect(
    (await f.post('/api/artifacts/agent/context', f.connection.endpointCredential, { ...read, catId: 'other-cat' }))
      .status,
  ).toBe(403);
  await f.store.updateArtifactAccess(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId,
    humanId: f.member.human.humanId,
    expectedAccessRevision: 1,
    access: 'revoked',
    requestId: 'remove-requester',
  });
  await f.store.updateArtifactAccess(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId,
    humanId: f.member.human.humanId,
    expectedAccessRevision: 2,
    access: 'read',
    requestId: 'restore-requester',
  });
  const retired = await f.post('/api/artifacts/agent/context', f.connection.endpointCredential, read);
  expect(retired.status).toBe(200);
  expect(retired.value.status).toBe('access_denied');
  expect(retired.value.requests).toEqual([]);
});

it('publishes a named request and its exact source projection atomically, recovers a lost reply after a new owner version and refuses rebinding', async () => {
  const f = await artifactFixture();
  const registered = await f.post('/api/artifacts/register', f.connection.endpointCredential, f.registration);
  const artifactId = registered.value.artifact.artifactId;
  await f.store.publishParticipation(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    revision: 1,
    agents: [{ catId: 'codex61-sol', displayName: 'Sol', channelIds: ['general'] }],
  });
  const input = {
    ...f.coordinates,
    artifactId,
    sourceEventId: f.source.eventId,
    ownerRevision: 1,
    annotationIds: ['owner-annotation-one'],
    expectedReviewRevision: 2,
    clientEventId: 'atomic-ask',
    body: '请改这处。',
    recipient: {
      kind: 'agent',
      humanId: f.owner.human.humanId,
      agentId: 'codex61-sol',
      connectionId: f.connection.connectionId,
      participationRevision: 1,
    },
  };
  const sent = await f.post('/api/artifacts/requests/publish', f.member.sessionToken, input);
  expect(sent.status).toBe(201);
  expect(sent.value.source.actor).toMatchObject({ kind: 'human', humanId: f.member.human.humanId });
  expect(sent.value.source.location).toEqual({ channelId: 'general', rootEventId: f.source.eventId });
  const source = sent.value.source;
  const context = f.store.readAgentArtifactContext(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    eventId: source.eventId,
    catId: 'codex61-sol',
    participationRevision: 1,
  });
  expect(context.requests).toHaveLength(1);
  expect(
    (
      await f.post('/api/artifacts/requests/publish', f.member.sessionToken, {
        ...input,
        body: 'silently change the same send',
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await f.post('/api/artifacts/requests/publish', f.member.sessionToken, {
        ...input,
        humanId: f.owner.human.humanId,
      })
    ).status,
  ).toBe(400);
  await f.post('/api/artifacts/register', f.connection.endpointCredential, {
    ...f.registration,
    expectedRevision: 1,
    expectedCustodyRevision: 1,
    ownerRevision: 2,
    blobDigest: `sha256:${'b'.repeat(64)}`,
    receiptRef: 'owner-receipt:next-version',
    requestId: 'publish-later',
  });
  const recovered = await f.post('/api/artifacts/requests/publish', f.member.sessionToken, input);
  expect(recovered.status).toBe(201);
  expect(recovered.value.source.eventId).toBe(source.eventId);
  expect(
    (await f.store.listEventsForHuman(f.member.sessionToken, f.coordinates.collectiveId)).filter(
      (event) => event.clientEventId === input.clientEventId,
    ),
  ).toHaveLength(1);
  const reopened = await CollectiveServiceStore.open({
    dataDirectory: f.directory,
    humanAuthProvider: f.humanAuthProvider,
  });
  expect((await reopened.store.publishArtifactRequest(f.member.sessionToken, input)).source.eventId).toBe(
    source.eventId,
  );
});

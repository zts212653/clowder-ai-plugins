import { expect, it } from 'vitest';
import { CollectiveServiceStore } from '../store.js';
import { artifactFixture } from './artifact.fixture.js';
import { nextArtifactOperation } from './artifact-request.fixture.js';

async function publishedRequest() {
  const f = await artifactFixture();
  const artifact = await f.store.registerArtifact(f.connection.endpointCredential, f.registration);
  await f.store.publishParticipation(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    revision: 1,
    agents: [{ catId: 'codex61-sol', displayName: 'Sol', channelIds: ['general'] }],
  });
  const input = {
    ...f.coordinates,
    artifactId: artifact.artifactId,
    sourceEventId: f.source.eventId,
    ownerRevision: 1,
    annotationIds: ['owner-annotation'],
    expectedReviewRevision: 2,
    clientEventId: 'lost-published-request',
    body: '请修改同一处。',
    recipient: {
      kind: 'agent',
      humanId: f.owner.human.humanId,
      agentId: 'codex61-sol',
      connectionId: f.connection.connectionId,
      participationRevision: 1,
    },
  };
  // The Service commits, but the caller discards the response and retains the exact browser operation.
  const committed = await f.post('/api/artifacts/requests/publish', f.member.sessionToken, input);
  expect(committed.status).toBe(201);
  const poll = { ...f.coordinates, connectionId: f.connection.connectionId };
  const context = { ...poll, eventId: committed.value.source.eventId, catId: 'codex61-sol', participationRevision: 1 };
  const prepare = async (store = f.store) =>
    store.requestArtifactOperation(f.member.sessionToken, {
      ...f.coordinates,
      artifactId: artifact.artifactId,
      sourceEventId: f.source.eventId,
      action: 'propose',
      ownerRevision: 1,
      requestId: `prepare:${input.clientEventId}`,
      payload: {
        kind: 'request-modification',
        messageEventId: committed.value.source.eventId,
        annotationIds: input.annotationIds,
        expectedReviewRevision: input.expectedReviewRevision,
      },
    });
  return { ...f, artifact, input, committed, poll, context, prepare };
}

for (const [subject, access] of [
  ['requester', 'apply'],
  ['target', 'read'],
] as const) {
  it(`recovers a committed request and prepares its owner after a live ${subject} access edit and restart`, async () => {
    const f = await publishedRequest();
    const oldRead = f.store.requestAgentArtifactOperation(f.connection.endpointCredential, {
      ...f.poll,
      artifactId: f.artifact.artifactId,
      sourceEventId: f.source.eventId,
      requestEventId: f.committed.value.source.eventId,
      catId: 'codex61-sol',
      participationRevision: 1,
      action: 'read',
      requestId: 'before-access-edit',
      payload: {},
    });
    const rejectedRead = expect(oldRead).rejects.toMatchObject({ code: 'ARTIFACT_ACCESS_DENIED' });
    expect(f.store.pollArtifactOperations(f.connection.endpointCredential, f.poll)).toHaveLength(1);
    await f.store.updateArtifactAccess(f.owner.sessionToken, {
      ...f.coordinates,
      artifactId: f.artifact.artifactId,
      humanId: subject === 'requester' ? f.member.human.humanId : f.owner.human.humanId,
      expectedAccessRevision: 1,
      access,
      requestId: `edit-${subject}`,
    });
    expect(f.store.pollArtifactOperations(f.connection.endpointCredential, f.poll)).toEqual([]);
    await rejectedRead;
    const replay = await f.post('/api/artifacts/requests/publish', f.member.sessionToken, f.input);
    expect(replay.status).toBe(201);
    expect(replay.value.source).toEqual(f.committed.value.source);
    expect(
      (
        await f.post('/api/artifacts/requests/publish', f.member.sessionToken, {
          ...f.input,
          body: 'change the committed request',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.post('/api/artifacts/requests/publish', f.member.sessionToken, {
          ...f.input,
          recipient: { ...f.input.recipient, agentId: 'another-cat' },
        })
      ).status,
    ).toBe(409);
    const { store } = await CollectiveServiceStore.open({
      dataDirectory: f.directory,
      humanAuthProvider: f.humanAuthProvider,
    });
    expect((await store.publishArtifactRequest(f.member.sessionToken, f.input)).source).toEqual(
      f.committed.value.source,
    );
    expect(store.readAgentArtifactContext(f.connection.endpointCredential, f.context).status).toBe('available');
    const pending = f.prepare(store);
    const operation = await nextArtifactOperation(store, f.connection.endpointCredential, f.poll);
    expect(operation.constraint.revocationEpoch).toBe(subject === 'requester' ? 2 : 1);
    expect(operation.constraint.requestTarget?.revocationEpoch).toBe(subject === 'target' ? 2 : 1);
    store.respondArtifactOperation(f.connection.endpointCredential, {
      ...f.poll,
      relayRef: operation.relayRef,
      status: 'ok',
      ownerDecisionRef: 'owner-prepared-original-request',
      value: { prepared: true },
    });
    expect(await pending).toEqual({ prepared: true });
    expect(
      (await store.listEventsForHuman(f.member.sessionToken, f.coordinates.collectiveId)).filter(
        (event) => event.clientEventId === f.input.clientEventId,
      ),
    ).toHaveLength(1);
  });
}

for (const subject of ['requester', 'target'] as const) {
  it(`acknowledges the immutable publication without reviving delegation after ${subject} revoke and restore`, async () => {
    const f = await publishedRequest();
    for (const [revision, access] of [
      [1, 'revoked'],
      [2, 'read'],
    ] as const) {
      await f.store.updateArtifactAccess(f.owner.sessionToken, {
        ...f.coordinates,
        artifactId: f.artifact.artifactId,
        humanId: subject === 'requester' ? f.member.human.humanId : f.owner.human.humanId,
        expectedAccessRevision: revision,
        access,
        requestId: `change-${revision}`,
      });
      if (access === 'revoked' && subject === 'requester')
        expect((await f.post('/api/artifacts/requests/publish', f.member.sessionToken, f.input)).status).toBe(403);
    }
    // A subsequent benign grant must not carry a source across an earlier revoked interval.
    await f.store.updateArtifactAccess(f.owner.sessionToken, {
      ...f.coordinates,
      artifactId: f.artifact.artifactId,
      humanId: subject === 'requester' ? f.member.human.humanId : f.owner.human.humanId,
      expectedAccessRevision: 3,
      access: 'apply',
      requestId: 'grant-after-restore',
    });
    const replay = await f.post('/api/artifacts/requests/publish', f.member.sessionToken, f.input);
    expect(replay.status).toBe(201);
    expect(replay.value.source).toEqual(f.committed.value.source);
    expect(f.store.readAgentArtifactContext(f.connection.endpointCredential, f.context)).toEqual({
      status: 'access_denied',
      requests: [],
    });
    await expect(f.prepare()).rejects.toMatchObject({ code: 'ARTIFACT_ACCESS_DENIED' });
    expect(f.store.pollArtifactOperations(f.connection.endpointCredential, f.poll)).toEqual([]);
  });
}

it('returns the original receipt after Cat removal and reentry without reviving its old participation', async () => {
  const f = await publishedRequest();
  await f.store.publishParticipation(f.connection.endpointCredential, { ...f.poll, revision: 2, agents: [] });
  await f.store.publishParticipation(f.connection.endpointCredential, {
    ...f.poll,
    revision: 3,
    agents: [{ catId: 'codex61-sol', displayName: 'Sol', channelIds: ['general'] }],
  });
  const replay = await f.post('/api/artifacts/requests/publish', f.member.sessionToken, f.input);
  expect(replay.status).toBe(201);
  expect(replay.value.source).toEqual(f.committed.value.source);
  await expect(f.prepare()).rejects.toMatchObject({ code: 'PARTICIPATION_REVOKED' });
  expect(f.store.pollArtifactOperations(f.connection.endpointCredential, f.poll)).toEqual([]);
});

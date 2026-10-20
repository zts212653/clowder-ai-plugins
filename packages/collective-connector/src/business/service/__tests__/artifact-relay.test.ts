import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { artifactFixture as fixture } from './artifact.fixture.js';

it('relays an authenticated operation only to its current content owner without persisting the payload', async () => {
  const f = await fixture();
  const registered = await f.post('/api/artifacts/register', f.connection.endpointCredential, f.registration);
  const input = {
    ...f.coordinates,
    artifactId: registered.value.artifact.artifactId,
    sourceEventId: f.source.eventId,
    action: 'read',
    ownerRevision: 1,
    requestId: 'read-guide-operation',
    payload: {},
  };
  const waiting = f.post('/api/artifacts/owner/request', f.member.sessionToken, input);
  let operations: Array<Record<string, unknown>> = [];
  for (let attempt = 0; attempt < 10 && !operations.length; attempt += 1) {
    const polled = await f.post('/api/artifacts/owner/poll', f.connection.endpointCredential, {
      ...f.coordinates,
      connectionId: f.connection.connectionId,
    });
    expect(polled.status).toBe(200);
    operations = polled.value.operations;
  }
  expect(operations).toHaveLength(1);
  const operation = operations[0];
  if (!operation) throw new Error('Expected one admitted owner operation');
  expect(operation).not.toHaveProperty('sessionToken');
  expect(operation.constraint).toMatchObject({
    humanId: f.member.human.humanId,
    contentRef: f.registration.contentRef,
    action: 'read',
    ownerRevision: 1,
  });
  const response = await f.post('/api/artifacts/owner/respond', f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    relayRef: operation.relayRef,
    status: 'ok',
    ownerDecisionRef: 'owner-allow:read',
    value: { text: '# Shared guide\nOwner bytes only.', ownerRevision: 1 },
  });
  expect(response.status).toBe(200);
  const received = await waiting;
  expect(received.status).toBe(200);
  expect(received.value.value.text).toContain('Owner bytes only.');
  const persisted = await readFile(join(f.directory, 'collective-service.json'), 'utf8');
  expect(persisted).not.toContain('Owner bytes only.');
  expect(persisted).not.toContain('relayRef');
});

it('rechecks revoke at response disclosure and refuses a response from another paired endpoint', async () => {
  const f = await fixture();
  const registered = await f.post('/api/artifacts/register', f.connection.endpointCredential, f.registration);
  const artifactId = registered.value.artifact.artifactId;
  const pending = f.store.requestArtifactOperation(f.member.sessionToken, {
    ...f.coordinates,
    artifactId,
    sourceEventId: f.source.eventId,
    action: 'read',
    requestId: 'read-before-revoke',
    payload: {},
  });
  const operations = f.store.pollArtifactOperations(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
  });
  const other = await f.pair();
  const response = {
    ...f.coordinates,
    connectionId: other.connectionId,
    relayRef: operations[0]?.relayRef,
    status: 'ok',
    ownerDecisionRef: 'owner-allow:read',
    value: { text: 'must not be disclosed' },
  };
  expect(() => f.store.respondArtifactOperation(other.endpointCredential, response)).toThrowError();
  await f.post('/api/artifacts/access/revoke', f.owner.sessionToken, {
    ...f.coordinates,
    artifactId,
    humanId: f.member.human.humanId,
    expectedAccessRevision: 1,
    requestId: 'revoke-during-read',
  });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'ARTIFACT_ACCESS_DENIED' });
  expect(() =>
    f.store.respondArtifactOperation(f.connection.endpointCredential, {
      ...response,
      connectionId: f.connection.connectionId,
    }),
  ).toThrowError();
  await rejected;
});

it('drops in-flight payloads at shutdown and retries the same owner operation without reviving the old relay', async () => {
  const f = await fixture();
  const registered = await f.post('/api/artifacts/register', f.connection.endpointCredential, f.registration);
  const input = {
    ...f.coordinates,
    artifactId: registered.value.artifact.artifactId,
    sourceEventId: f.source.eventId,
    action: 'read',
    requestId: 'retry-after-stop',
    payload: {},
  };
  const first = f.store.requestArtifactOperation(f.member.sessionToken, input);
  const poll = { ...f.coordinates, connectionId: f.connection.connectionId };
  const before = f.store.pollArtifactOperations(f.connection.endpointCredential, poll)[0];
  const stopped = expect(first).rejects.toMatchObject({ code: 'ARTIFACT_OWNER_UNAVAILABLE' });
  f.store.stopArtifactOwnerRelay();
  await stopped;
  expect(() => f.store.requestArtifactOperation(f.member.sessionToken, input)).toThrowError();
  f.store.startArtifactOwnerRelay();
  const retry = f.store.requestArtifactOperation(f.member.sessionToken, input);
  const after = f.store.pollArtifactOperations(f.connection.endpointCredential, poll)[0];
  expect(after?.relayRef).not.toBe(before?.relayRef);
  expect(after?.requestId).toBe(before?.requestId);
  expect(() =>
    f.store.respondArtifactOperation(f.connection.endpointCredential, {
      ...poll,
      relayRef: before?.relayRef,
      status: 'ok',
      ownerDecisionRef: 'owner-allow:late',
      value: { text: 'late old response' },
    }),
  ).toThrowError();
  f.store.respondArtifactOperation(f.connection.endpointCredential, {
    ...poll,
    relayRef: after?.relayRef,
    status: 'ok',
    ownerDecisionRef: 'owner-allow:retry',
    value: { text: 'reconciled current response' },
  });
  expect(await retry).toEqual({ text: 'reconciled current response' });
});

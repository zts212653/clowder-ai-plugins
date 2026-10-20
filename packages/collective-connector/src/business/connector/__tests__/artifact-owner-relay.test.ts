import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { fixture } from './communication-work-custody.fixture.js';

const opened: Array<Awaited<ReturnType<typeof fixture>>> = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((f) => f.close()));
});

it('uses the existing connection for ephemeral owner operations, with fresh authority and no persisted payload', async () => {
  const f = await fixture();
  opened.push(f);
  let ownerCalls = 0;
  f.connector.setArtifactOwner({
    async execute(operation, authority) {
      ownerCalls += 1;
      const fresh = await authority.reauthorize();
      expect(fresh).toEqual(operation.constraint);
      expect(operation).not.toHaveProperty('endpointCredential');
      return { status: 'ok', ownerDecisionRef: 'owner-allow:read-1', value: { text: '# Canonical owner body' } };
    },
  });
  const artifact = await f.connector.registerArtifact(f.connection.connectionId, 'local-owner', {
    contentRef: 'content:shared-guide',
    title: 'Shared guide',
    mediaType: 'text/markdown',
    sourceEventId: f.source.eventId,
    ownerRevision: 1,
    blobDigest: `sha256:${'a'.repeat(64)}`,
    receiptRef: 'owner-receipt:import',
    requestId: 'publish-shared-guide',
  });
  const pending = f.store.requestArtifactOperation(f.owner.sessionToken, {
    serviceInstanceId: f.connection.serviceInstanceId,
    collectiveId: f.connection.collectiveId,
    artifactId: artifact.artifactId,
    sourceEventId: f.source.eventId,
    action: 'read',
    requestId: 'read-through-connector',
    payload: {},
  });
  await f.connector.sync(f.connection.connectionId);
  expect(await pending).toEqual({ text: '# Canonical owner body' });
  expect(ownerCalls).toBe(1);
  const state = await readFile(join(f.root, 'connector', 'collective-connector.json'), 'utf8');
  expect(state).not.toContain('Canonical owner body');
  expect(state).not.toContain('artifact-relay:');
});

it('never discloses an owner response after access changes during execution', async () => {
  const f = await fixture();
  opened.push(f);
  const artifact = await f.connector.registerArtifact(f.connection.connectionId, 'local-owner', {
    contentRef: 'content:revoked-guide',
    title: 'Guide',
    mediaType: 'text/markdown',
    sourceEventId: f.source.eventId,
    ownerRevision: 1,
    blobDigest: `sha256:${'a'.repeat(64)}`,
    receiptRef: 'owner-receipt:revoked-import',
    requestId: 'publish-revoked-guide',
  });
  f.connector.setArtifactOwner({
    async execute() {
      await f.store.updateArtifactAccess(f.owner.sessionToken, {
        serviceInstanceId: f.connection.serviceInstanceId,
        collectiveId: f.connection.collectiveId,
        artifactId: artifact.artifactId,
        humanId: f.owner.human.humanId,
        expectedAccessRevision: 1,
        access: 'revoked',
        requestId: 'revoke-during-owner-load',
      });
      return { status: 'ok', ownerDecisionRef: 'owner-allow:obsolete', value: { text: 'must stay private' } };
    },
  });
  const pending = f.store.requestArtifactOperation(f.owner.sessionToken, {
    serviceInstanceId: f.connection.serviceInstanceId,
    collectiveId: f.connection.collectiveId,
    artifactId: artifact.artifactId,
    sourceEventId: f.source.eventId,
    action: 'read',
    requestId: 'read-before-revoke',
    payload: {},
  });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'ARTIFACT_ACCESS_DENIED' });
  await f.connector.sync(f.connection.connectionId);
  await rejected;
});

it('a verified Cat RPC releases the authority lock while the same Cafe polls its owner', async () => {
  const f = await fixture();
  opened.push(f);
  const artifact = await f.connector.registerArtifact(f.connection.connectionId, 'local-owner', {
    contentRef: 'content:shared-agent-rpc',
    title: 'Guide',
    mediaType: 'text/markdown',
    sourceEventId: f.source.eventId,
    ownerRevision: 1,
    blobDigest: `sha256:${'a'.repeat(64)}`,
    receiptRef: 'owner-receipt:agent-import',
    requestId: 'publish-agent-guide',
  });
  const ask = await f.store.postHumanMessage(f.owner.sessionToken, {
    serviceInstanceId: f.connection.serviceInstanceId,
    collectiveId: f.connection.collectiveId,
    clientEventId: 'ask-shared-guide',
    location: { channelId: 'general', rootEventId: f.source.eventId },
    recipient: {
      kind: 'agent',
      humanId: f.owner.human.humanId,
      connectionId: f.connection.connectionId,
      agentId: 'codex-sol',
      participationRevision: 1,
    },
    body: 'Please clarify the shared guide.',
  });
  if (!ask.location) throw new Error('Expected the public request location');
  const source = { ...f.source, eventId: ask.eventId, location: ask.location, actor: ask.actor };
  const input = {
    artifactId: artifact.artifactId,
    sourceEventId: f.source.eventId,
    action: 'read' as const,
    requestId: 'agent-read-guide',
    payload: {},
  };
  await expect(
    f.connector.requestArtifactForAgent(source, { ...f.agent, sessionRef: 'forged' }, input),
  ).rejects.toMatchObject({ code: 'AGENT_PROVENANCE_UNVERIFIED' });
  f.connector.setArtifactOwner({
    async execute() {
      return { status: 'ok', ownerDecisionRef: 'owner-allow:prepared', value: { prepared: true } };
    },
  });
  let prepared = false;
  const preparing = f.store
    .requestArtifactOperation(f.owner.sessionToken, {
      serviceInstanceId: f.connection.serviceInstanceId,
      collectiveId: f.connection.collectiveId,
      artifactId: artifact.artifactId,
      sourceEventId: f.source.eventId,
      action: 'propose',
      requestId: 'prepare-cat-request',
      payload: {
        kind: 'request-modification',
        messageEventId: ask.eventId,
        annotationIds: ['annotation-one'],
        expectedReviewRevision: 1,
      },
    })
    .then(() => {
      prepared = true;
    });
  for (let i = 0; i < 40 && !prepared; i += 1) {
    await f.connector.sync(f.connection.connectionId);
    if (!prepared) await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  await preparing;
  let executing = false;
  let entered!: () => void;
  const reachedOwner = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.connector.setArtifactOwner({
    async execute(operation) {
      executing = true;
      entered();
      expect(operation.constraint.agent).toMatchObject({ catId: 'codex-sol', requestEventId: ask.eventId });
      return { status: 'ok', ownerDecisionRef: 'owner-allow:agent-read', value: { text: 'shared owner bytes' } };
    },
  });
  const waiting = f.connector.requestArtifactForAgent(source, f.agent, input);
  // Repeated sync only waits for real HTTP admission. Holding its local authority lock across RPC would deadlock.
  for (let i = 0; i < 30 && !executing; i += 1) {
    await f.connector.sync(f.connection.connectionId);
    if (!executing) await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  await reachedOwner;
  expect(await waiting).toEqual({ text: 'shared owner bytes' });
  const persisted = await readFile(join(f.root, 'connector', 'collective-connector.json'), 'utf8');
  expect(persisted).not.toContain('shared owner bytes');
});

it('an older Service keeps ordinary participation available while reporting the separate W4 capability unavailable', async () => {
  const f = await fixture({ legacyArtifactContext: true });
  opened.push(f);
  expect((await f.connector.readParticipationContext(f.source)).source.eventId).toBe(f.source.eventId);
  expect(await f.connector.readArtifactContext(f.source)).toEqual({ status: 'unavailable', requests: [] });
});

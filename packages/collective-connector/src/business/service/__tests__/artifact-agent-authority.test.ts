import { maxCollectiveArtifactProposalPayloadBytes } from '../../contracts/index.js';
import { expect, it } from 'vitest';
import { artifactFixture } from './artifact.fixture.js';
import { nextArtifactOperation } from './artifact-request.fixture.js';

async function fixture() {
  const f = await artifactFixture();
  const published = await f.post('/api/artifacts/register', f.connection.endpointCredential, f.registration);
  await f.store.publishParticipation(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    revision: 1,
    agents: [{ catId: 'codex61-sol', displayName: 'Sol', channelIds: ['general'] }],
  });
  const request = await f.store.postHumanMessage(f.member.sessionToken, {
    ...f.coordinates,
    clientEventId: 'request-cat',
    location: { channelId: 'general', rootEventId: f.source.eventId },
    recipient: {
      kind: 'agent',
      humanId: f.owner.human.humanId,
      connectionId: f.connection.connectionId,
      agentId: 'codex61-sol',
      participationRevision: 1,
    },
    body: '请解释这处说明。',
  });
  const artifactId = published.value.artifact.artifactId;
  const poll = { ...f.coordinates, connectionId: f.connection.connectionId };
  const preparing = f.store.requestArtifactOperation(f.member.sessionToken, {
    ...f.coordinates,
    artifactId,
    sourceEventId: f.source.eventId,
    action: 'propose',
    requestId: 'prepare-cat-request',
    payload: {
      kind: 'request-modification',
      messageEventId: request.eventId,
      annotationIds: ['annotation-one'],
      expectedReviewRevision: 1,
    },
  });
  const prepared = await nextArtifactOperation(f.store, f.connection.endpointCredential, poll);
  f.store.respondArtifactOperation(f.connection.endpointCredential, {
    ...poll,
    relayRef: prepared.relayRef,
    status: 'ok',
    ownerDecisionRef: 'owner-allow:prepared',
    value: { prepared: true },
  });
  await preparing;
  return {
    ...f,
    request,
    artifactId: published.value.artifact.artifactId,
    poll: { ...f.coordinates, connectionId: f.connection.connectionId },
  };
}

it('a Cat loses an in-flight read when either its Human or the requesting Human loses Artifact access', async () => {
  for (const revoked of ['requester', 'cat-owner']) {
    const f = await fixture();
    const pending = f.store.requestAgentArtifactOperation(f.connection.endpointCredential, {
      ...f.poll,
      artifactId: f.artifactId,
      sourceEventId: f.source.eventId,
      requestEventId: f.request.eventId,
      catId: 'codex61-sol',
      participationRevision: 1,
      action: 'read',
      requestId: 'cat-read',
      payload: {},
    });
    const operation = f.store.pollArtifactOperations(f.connection.endpointCredential, f.poll)[0];
    expect(operation?.constraint.agent?.catId).toBe('codex61-sol');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ARTIFACT_ACCESS_DENIED' });
    await f.store.updateArtifactAccess(f.owner.sessionToken, {
      ...f.coordinates,
      artifactId: f.artifactId,
      humanId: revoked === 'requester' ? f.member.human.humanId : f.owner.human.humanId,
      expectedAccessRevision: 1,
      access: 'revoked',
      requestId: `revoke-${revoked}`,
    });
    expect(f.store.pollArtifactOperations(f.connection.endpointCredential, f.poll)).toEqual([]);
    await rejected;
  }
});

it('a Human modification request cannot keep a stale Cat recipient alive through the owner relay', async () => {
  const f = await fixture();
  const pending = f.store.requestArtifactOperation(f.member.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifactId,
    sourceEventId: f.source.eventId,
    action: 'propose',
    requestId: 'ask-cat',
    payload: {
      kind: 'request-modification',
      messageEventId: f.request.eventId,
      annotationIds: ['annotation-one'],
      expectedReviewRevision: 1,
    },
  });
  const polled = await nextArtifactOperation(f.store, f.connection.endpointCredential, f.poll);
  expect(polled?.constraint.requestTarget).toMatchObject({ catId: 'codex61-sol', membershipRevision: 1 });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'ARTIFACT_ACCESS_DENIED' });
  await f.store.updateArtifactAccess(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifactId,
    humanId: f.owner.human.humanId,
    expectedAccessRevision: 1,
    access: 'revoked',
    requestId: 'revoke-recipient',
  });
  expect(f.store.pollArtifactOperations(f.connection.endpointCredential, f.poll)).toEqual([]);
  await rejected;
  expect(
    (
      await f.post('/api/artifacts/constraints', f.member.sessionToken, {
        ...f.coordinates,
        artifactId: f.artifactId,
        sourceEventId: f.source.eventId,
        action: 'read',
      })
    ).status,
  ).toBe(201);
});

it('issues only replay authority for a frozen Cat proposal and invalidates it on cancellation', async () => {
  const f = await fixture();
  const pairing = await f.store.createPairingIntent({
    sessionToken: f.member.sessionToken,
    collectiveId: f.coordinates.collectiveId,
    hostOrigin: 'http://localhost:5183',
    nonce: 'frozen-replay-target',
  });
  await f.store.exchangePairingIntent({ ...pairing, endpointLabel: 'Target Cafe' });
  const offered = await f.store.offerArtifactCustody(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifactId,
    expectedCustodyRevision: 1,
    targetHumanId: f.member.human.humanId,
    requestId: 'offer-replay-custody',
  });
  const transfer = { ...f.poll, artifactId: f.artifactId, transferId: offered.handoffRef };
  await f.store.prepareArtifactCustody(f.connection.endpointCredential, {
    ...transfer,
    proof: {
      preparedRef: 'prepared-replay',
      ownerScopeRef: 'owner-scope:shared-guide',
      manifest: { digest: `sha256:${'b'.repeat(64)}`, totalBytes: 1000, pageCount: 1 },
      version: {
        contentRef: f.registration.contentRef,
        ownerRevision: 1,
        blobDigest: f.registration.blobDigest,
        receiptRef: f.registration.receiptRef,
      },
    },
  });
  const input = {
    ...f.poll,
    artifactId: f.artifactId,
    sourceEventId: f.source.eventId,
    requestEventId: f.request.eventId,
    catId: 'codex61-sol',
    participationRevision: 1,
    action: 'propose',
    requestId: 'replay-proposal',
    payload: { kind: 'respond-modification' },
  };
  const pending = f.store.requestAgentArtifactOperation(f.connection.endpointCredential, input);
  const operation = await nextArtifactOperation(f.store, f.connection.endpointCredential, f.poll);
  expect(operation.constraint.effectMode).toBe('replay_only');
  const validation = {
    ...f.poll,
    artifactId: f.artifactId,
    sourceEventId: f.source.eventId,
    action: 'propose',
    decisionRef: operation.constraint.decisionRef,
  };
  expect(f.store.validateArtifactConstraint(f.connection.endpointCredential, validation).effectMode).toBe(
    'replay_only',
  );
  f.store.respondArtifactOperation(f.connection.endpointCredential, {
    ...f.poll,
    relayRef: operation.relayRef,
    status: 'ok',
    ownerDecisionRef: 'owner-allow:existing-operation',
    value: { proposalRef: 'existing-proposal' },
  });
  expect(await pending).toEqual({ proposalRef: 'existing-proposal' });
  expect(() =>
    f.store.requestAgentArtifactOperation(f.connection.endpointCredential, {
      ...input,
      action: 'read',
      requestId: 'lazy-read-after-freeze',
      payload: {},
    }),
  ).toThrow(expect.objectContaining({ code: 'ARTIFACT_OWNER_UNAVAILABLE' }));
  await f.store.cancelArtifactCustody(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifactId,
    transferId: offered.handoffRef,
  });
  expect(() => f.store.validateArtifactConstraint(f.connection.endpointCredential, validation)).toThrow();
});

it('bounds total transient Cat payload memory, retains replay under pressure and releases the budget after response or shutdown', async () => {
  const f = await fixture();
  const input = {
    ...f.poll,
    artifactId: f.artifactId,
    sourceEventId: f.source.eventId,
    requestEventId: f.request.eventId,
    catId: 'codex61-sol',
    participationRevision: 1,
    action: 'propose',
    requestId: 'large-0',
    payload: { kind: 'respond-modification', wireTest: 'x'.repeat(maxCollectiveArtifactProposalPayloadBytes - 1000) },
  };
  // This checks relay accounting only; the real owner validates patch semantics in the API callback journey.
  const pending: Array<Promise<unknown>> = [];
  const failures: Array<Promise<unknown>> = [];
  const start = (requestId: string) => {
    const operation = f.store.requestAgentArtifactOperation(f.connection.endpointCredential, { ...input, requestId });
    pending.push(operation);
    failures.push(operation.catch((error: unknown) => error));
    return operation;
  };
  try {
    for (let index = 0; index < 4; index++) start(`large-${index}`);
    expect(() => start('large-4')).toThrow(expect.objectContaining({ code: 'ARTIFACT_BUSY' }));
    expect(f.store.requestAgentArtifactOperation(f.connection.endpointCredential, input)).toBe(pending[0]);
    expect(
      (
        await f.post('/api/artifacts/agent/request', f.connection.endpointCredential, {
          ...input,
          requestId: 'oversized',
          payload: { kind: 'respond-modification', text: 'x'.repeat(maxCollectiveArtifactProposalPayloadBytes) },
        })
      ).status,
    ).toBe(413);
    const human = await f.post('/api/artifacts/owner/request', f.member.sessionToken, {
      ...f.coordinates,
      artifactId: f.artifactId,
      sourceEventId: f.source.eventId,
      action: 'read',
      requestId: 'human-still-bounded',
      payload: { text: 'x'.repeat(65536) },
    });
    expect(human.status).toBe(413);
    const first = f.store.pollArtifactOperations(f.connection.endpointCredential, f.poll)[0];
    f.store.respondArtifactOperation(f.connection.endpointCredential, {
      ...f.poll,
      relayRef: first?.relayRef,
      status: 'ok',
      ownerDecisionRef: 'receipt-only',
      value: { receiptRef: 'one' },
    });
    expect(await pending[0]).toEqual({ receiptRef: 'one' });
    start('large-4');
    f.store.stopArtifactOwnerRelay();
    await Promise.all(failures);
    f.store.startArtifactOwnerRelay();
    start('after-stop');
    expect(f.store.pollArtifactOperations(f.connection.endpointCredential, f.poll)).toHaveLength(1);
  } finally {
    f.store.stopArtifactOwnerRelay();
    await Promise.all(failures);
  }
});

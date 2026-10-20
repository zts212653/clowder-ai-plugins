import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SERVICE_STATE_FILE } from '../persistence.js';
import { transferFixture } from './artifact-transfer.fixture.js';

it('preserves each proof and the unique custody/access CAS across Service restarts and lost responses', async () => {
  const f = await transferFixture();
  let store = await f.reopen();
  expect(store.readArtifactCustody(f.connection.endpointCredential, f.sourceInput).state).toBe('offered');
  const old = store.issueArtifactConstraint(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    sourceEventId: f.source.eventId,
    action: 'read',
  });
  await f.prepare();
  store = await f.reopen();
  expect(store.readArtifactCustody(f.target.endpointCredential, f.targetInput).prepared).toEqual(f.proof);
  await f.attest();
  store = await f.reopen();
  expect(store.readArtifactCustody(f.connection.endpointCredential, f.sourceInput).state).toBe('target_ready');
  const accepted = await store.acceptArtifactCustody(f.target.endpointCredential, f.accept);
  expect(accepted.accessRevision).toBe(2);
  expect(accepted.availability).toBe('owner_unavailable');
  expect(accepted.publishedByHumanId).toBe(f.owner.human.humanId);
  expect(accepted).not.toHaveProperty('custodyTransfers');
  store = await f.reopen();
  expect(await store.acceptArtifactCustody(f.target.endpointCredential, f.accept)).toEqual(accepted);
  expect(store.readArtifactCustody(f.target.endpointCredential, f.targetInput).state).toBe('committed');
  expect(() =>
    store.validateArtifactConstraint(f.connection.endpointCredential, {
      ...f.coordinates,
      connectionId: f.connection.connectionId,
      artifactId: f.artifact.artifactId,
      sourceEventId: f.source.eventId,
      action: 'read',
      decisionRef: old.decisionRef,
    }),
  ).toThrow();
  await expect(store.cancelArtifactCustody(f.owner.sessionToken, f.input)).rejects.toMatchObject({
    code: 'ARTIFACT_CUSTODY_HANDOFF_REQUIRED',
  });
  await expect(
    store.acceptArtifactCustody(f.target.endpointCredential, {
      ...f.accept,
      requestId: 'wrong-replay',
      contentRef: 'wrong',
    }),
  ).rejects.toMatchObject({ code: 'ARTIFACT_ACCESS_DENIED' });
  expect(
    store.authorizeArtifactCustody(f.target.endpointCredential, { ...f.targetInput, operation: 'finalize' }).state,
  ).toBe('committed');
  await store.finalizeArtifactCustody(f.target.endpointCredential, { ...f.targetInput, outcome: 'committed' });
  expect(
    store.issueArtifactConstraint(f.owner.sessionToken, {
      ...f.coordinates,
      artifactId: f.artifact.artifactId,
      sourceEventId: f.source.eventId,
      action: 'read',
    }).custodyRevision,
  ).toBe(2);
  const persisted = await readFile(join(f.directory, SERVICE_STATE_FILE), 'utf8');
  expect(persisted).not.toContain('pageBase64');
  expect(persisted).not.toContain('candidateText');
});

it('requires source preparation before target readiness and checks the exact digest/scope/endpoint', async () => {
  const f = await transferFixture();
  await expect(f.attest()).rejects.toMatchObject({ code: 'ARTIFACT_CUSTODY_HANDOFF_REQUIRED' });
  await expect(
    f.store.prepareArtifactCustody(f.target.endpointCredential, { ...f.targetInput, proof: f.proof }),
  ).rejects.toMatchObject({ code: 'ARTIFACT_ACCESS_DENIED' });
  await expect(
    f.store.prepareArtifactCustody(f.connection.endpointCredential, {
      ...f.sourceInput,
      proof: { ...f.proof, version: { ...f.proof.version, ownerRevision: 2 } },
    }),
  ).rejects.toMatchObject({ code: 'ARTIFACT_CUSTODY_HANDOFF_REQUIRED' });
  await f.prepare();
  for (const changed of [
    { manifestDigest: `sha256:${'c'.repeat(64)}` },
    { preparedRef: 'wrong-source-proof' },
    { ownerScopeRef: 'wrong-scope' },
  ]) {
    await expect(
      f.store.readyArtifactCustody(f.target.endpointCredential, {
        ...f.targetInput,
        proof: { ...f.ready, ...changed },
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_ACCESS_DENIED' });
  }
  await f.attest();
  expect(() => f.store.readArtifactCustody(f.owner.sessionToken, f.sourceInput)).toThrow();
});

it('freezes preexisting and new effects after source preparation while keeping fresh Human reads', async () => {
  const f = await transferFixture();
  const base = { ...f.coordinates, artifactId: f.artifact.artifactId, sourceEventId: f.source.eventId };
  const oldWrite = f.store.issueArtifactConstraint(f.owner.sessionToken, { ...base, action: 'annotate' });
  await f.prepare();
  expect(f.store.issueArtifactConstraint(f.owner.sessionToken, { ...base, action: 'read' }).action).toBe('read');
  for (const action of ['annotate', 'propose', 'apply', 'cancel', 'reject']) {
    expect(() => f.store.issueArtifactConstraint(f.owner.sessionToken, { ...base, action })).toThrow(
      expect.objectContaining({ code: 'ARTIFACT_OWNER_UNAVAILABLE' }),
    );
  }
  expect(() =>
    f.store.validateArtifactConstraint(f.connection.endpointCredential, {
      ...base,
      connectionId: f.connection.connectionId,
      action: 'annotate',
      decisionRef: oldWrite.decisionRef,
    }),
  ).toThrow(expect.objectContaining({ code: 'ARTIFACT_OWNER_UNAVAILABLE' }));
  await expect(
    f.store.registerArtifact(f.connection.endpointCredential, {
      ...f.registration,
      ownerRevision: 2,
      expectedRevision: 1,
      expectedCustodyRevision: 1,
      requestId: 'late-register',
    }),
  ).rejects.toMatchObject({ code: 'ARTIFACT_OWNER_UNAVAILABLE' });
});

for (const phase of ['offered', 'source_prepared', 'target_ready'])
  it(`cancels ${phase} durably, including an unavailable target, and never commits its old ready proof`, async () => {
    const f = await transferFixture();
    if (phase !== 'offered') await f.prepare();
    if (phase === 'target_ready') await f.attest();
    await f.store.revokeConnection({
      sessionToken: f.owner.sessionToken,
      collectiveId: f.coordinates.collectiveId,
      connectionId: f.target.connectionId,
    });
    await f.store.cancelArtifactCustody(f.owner.sessionToken, f.input);
    const store = await f.reopen();
    expect(store.readArtifactCustody(f.connection.endpointCredential, f.sourceInput).state).toBe('cancelled');
    expect(store.readArtifactCustody(f.target.endpointCredential, f.targetInput).state).toBe('cancelled');
    expect(await store.offerArtifactCustody(f.owner.sessionToken, f.offerInput)).toEqual({
      handoffRef: f.input.transferId,
    });
    expect(
      store.issueArtifactConstraint(f.owner.sessionToken, {
        ...f.coordinates,
        artifactId: f.artifact.artifactId,
        sourceEventId: f.source.eventId,
        action: 'annotate',
      }).action,
    ).toBe('annotate');
    await expect(store.acceptArtifactCustody(f.target.endpointCredential, f.accept)).rejects.toThrow();
  });

it('rejects oversized or inconsistent manifest bounds without preparing source custody', async () => {
  const f = await transferFixture();
  for (const manifest of [
    { ...f.proof.manifest, totalBytes: 16 * 1024 * 1024 + 1, pageCount: 513 },
    { ...f.proof.manifest, totalBytes: 1000, pageCount: 2 },
  ]) {
    const result = await f.post('/api/artifacts/custody/prepared', f.connection.endpointCredential, {
      ...f.sourceInput,
      proof: { ...f.proof, manifest },
    });
    expect(result.status).toBe(400);
  }
  expect(f.store.readArtifactCustody(f.connection.endpointCredential, f.sourceInput).state).toBe('offered');
});

it('keeps old offer retries bound to their own transfer and retires acknowledged terminal deliveries', async () => {
  const f = await transferFixture();
  await f.store.cancelArtifactCustody(f.owner.sessionToken, f.input);
  const next = await f.store.offerArtifactCustody(f.owner.sessionToken, {
    ...f.offerInput,
    requestId: 'next-transfer-offer',
  });
  expect(next.handoffRef).not.toBe(f.input.transferId);
  expect(await f.store.offerArtifactCustody(f.owner.sessionToken, f.offerInput)).toEqual({
    handoffRef: f.input.transferId,
  });
  await f.store.finalizeArtifactCustody(f.connection.endpointCredential, { ...f.sourceInput, outcome: 'cancelled' });
  const afterRestart = await f.reopen();
  expect(
    afterRestart
      .pollArtifactCustody(f.connection.endpointCredential, {
        ...f.coordinates,
        connectionId: f.connection.connectionId,
      })
      .map((transfer) => transfer.transferId),
  ).toEqual([next.handoffRef]);
});

it('keeps committed custody unavailable until the exact target activates with fresh membership and artifact access', async () => {
  const f = await transferFixture();
  await f.prepare();
  await f.attest();
  await f.store.acceptArtifactCustody(f.target.endpointCredential, f.accept);
  await f.store.finalizeArtifactCustody(f.connection.endpointCredential, { ...f.sourceInput, outcome: 'committed' });
  const read = { ...f.coordinates, artifactId: f.artifact.artifactId, sourceEventId: f.source.eventId, action: 'read' };
  expect(() => f.store.issueArtifactConstraint(f.owner.sessionToken, read)).toThrow(
    expect.objectContaining({ code: 'ARTIFACT_OWNER_UNAVAILABLE' }),
  );
  await f.store.updateArtifactAccess(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    humanId: f.member.human.humanId,
    expectedAccessRevision: 2,
    access: 'revoked',
    requestId: 'deny-before-target-activation',
  });
  expect(() =>
    f.store.authorizeArtifactCustody(f.target.endpointCredential, { ...f.targetInput, operation: 'finalize' }),
  ).toThrow(expect.objectContaining({ code: 'ARTIFACT_ACCESS_DENIED' }));
  await expect(
    f.store.finalizeArtifactCustody(f.target.endpointCredential, { ...f.targetInput, outcome: 'committed' }),
  ).rejects.toMatchObject({ code: 'ARTIFACT_ACCESS_DENIED' });
  expect(() => f.store.issueArtifactConstraint(f.owner.sessionToken, read)).toThrow(
    expect.objectContaining({ code: 'ARTIFACT_OWNER_UNAVAILABLE' }),
  );
});

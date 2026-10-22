import { createHash } from 'node:crypto';
import { collectiveWorkResultFilePath } from '../../contracts/index.js';
import { expect, it } from 'vitest';
import { startCollectiveServer } from '../http-server.js';
import { admittedWorkWithFileFixture } from './work-result-file.fixture.js';

it('promotes the exact current Markdown Work result through the authenticated HTTP route', async () => {
  const f = await admittedWorkWithFileFixture();
  const result = await f.store.postAgentMessage(f.connection.endpointCredential, f.legacyResult);
  await f.store.bindAcceptedWorkResultFile(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    resultEventId: result.eventId,
    workResultFile: f.workResultFile,
  });
  const invite = await f.store.createInvite({
    sessionToken: f.owner.sessionToken,
    collectiveId: f.coordinates.collectiveId,
  });
  const attempt = await f.store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
  });
  const completion = await f.store.completeHumanAuth({
    provider: 'github',
    state: attempt.state,
    code: 'foreign-member',
  });
  const member = await f.store.exchangeHumanAuthCompletion(completion.completionToken);
  const server = await startCollectiveServer({ store: f.store, host: '127.0.0.1', port: 0 });
  const promotionInput = {
    ...f.coordinates,
    fileId: f.fileId,
  };
  try {
    const resolve = (sessionToken: string, input = promotionInput) =>
      fetch(`${server.url}/api/artifacts/publications/resolve-result`, {
        method: 'POST',
        headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    const [ownerBefore, memberBefore, missingBefore] = await Promise.all([
      resolve(f.owner.sessionToken),
      resolve(member.sessionToken),
      resolve(f.owner.sessionToken, { ...promotionInput, fileId: `wrf_${'f'.repeat(64)}` }),
    ]);
    expect(ownerBefore.status).toBe(200);
    expect(await ownerBefore.json()).toEqual({ resolution: { status: 'unpublished', mayPromote: true } });
    expect(memberBefore.status).toBe(200);
    expect(await memberBefore.json()).toEqual({ resolution: { status: 'unpublished', mayPromote: false } });
    expect(missingBefore.status).toBe(404);

    const denied = await fetch(`${server.url}/api/artifacts/publications/promote-result`, {
      method: 'POST',
      headers: { authorization: `Bearer ${member.sessionToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(promotionInput),
    });
    expect(denied.status).toBe(403);

    const pendingResponse = fetch(`${server.url}/api/artifacts/publications/promote-result`, {
      method: 'POST',
      headers: { authorization: `Bearer ${f.owner.sessionToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(promotionInput),
    });
    let operation: Awaited<ReturnType<typeof f.store.pollArtifactPublications>>[number] | undefined;
    for (let attemptIndex = 0; attemptIndex < 40 && !operation; attemptIndex += 1) {
      operation = (
        await f.store.pollArtifactPublications(f.connection.endpointCredential, {
          ...f.coordinates,
          connectionId: f.connection.connectionId,
        })
      )[0];
      if (!operation) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(operation).toBeTruthy();
    if (!operation) throw new Error('Expected a Work result publication operation');
    expect(operation.bytesBase64).toBe(f.workResultFile.contentBase64);
    expect(operation.publication).toMatchObject({
      workId: f.work.workId,
      sourceEventId: f.work.sourceEventId,
      title: f.acceptance.title,
      blobDigest: f.contentDigest,
    });
    await f.store.validateArtifactPublication(f.connection.endpointCredential, {
      ...f.coordinates,
      connectionId: f.connection.connectionId,
      publicationId: operation.publication.publicationId,
      relayRef: operation.relayRef,
    });
    const publication = operation.publication;
    const scope = {
      kind: 'collective-artifact',
      serviceInstanceId: publication.serviceInstanceId,
      collectiveId: publication.collectiveId,
      artifactId: publication.artifactId,
      contentRef: publication.contentRef,
      sourceEventId: publication.sourceEventId,
      publishedByHumanId: publication.humanId,
    };
    await f.store.respondArtifactPublication(f.connection.endpointCredential, {
      ...f.coordinates,
      connectionId: f.connection.connectionId,
      relayRef: operation.relayRef,
      status: 'ok',
      ownerDecisionRef: publication.publicationId,
      value: {
        receipt: {
          receiptId: `receipt:${publication.publicationId}`,
          contentRef: publication.contentRef,
          previousOwnerRevision: 0,
          ownerRevision: 1,
          blobDigest: publication.blobDigest,
          actor: { kind: 'human', actorId: publication.humanId },
          operationId: publication.publicationId,
          outboxSequence: 1,
          operationContext: {
            kind: 'collective-artifact:publish',
            requestDigest: publication.requestDigest,
            actorHumanId: publication.humanId,
            scopeRef: `collective-owner:${createHash('sha256').update(JSON.stringify(scope)).digest('hex')}`,
            custodyRevision: 1,
            dispositionId: publication.publicationId,
          },
        },
      },
    });
    const promoted = await pendingResponse;
    expect(promoted.status).toBe(201);
    expect(await promoted.json()).toMatchObject({
      publication: {
        status: 'published',
        sourceEventId: f.work.sourceEventId,
        artifact: {
          workId: f.work.workId,
          versions: [{ blobDigest: f.contentDigest }],
        },
      },
    });
    const [ownerOpen, memberOpen] = await Promise.all([
      resolve(f.owner.sessionToken),
      resolve(member.sessionToken),
    ]);
    expect(ownerOpen.status).toBe(200);
    expect(memberOpen.status).toBe(200);
    const ownerResolution = await ownerOpen.json();
    const memberResolution = await memberOpen.json();
    expect(ownerResolution).toMatchObject({
      resolution: { status: 'published', artifact: { publishedByHumanId: f.owner.human.humanId } },
    });
    expect(memberResolution).toMatchObject({
      resolution: {
        status: 'published',
        artifact: { artifactId: ownerResolution.resolution.artifact.artifactId, canApply: false },
      },
    });
    await f.store.updateArtifactAccess(f.owner.sessionToken, {
      ...f.coordinates,
      artifactId: ownerResolution.resolution.artifact.artifactId,
      humanId: member.human.humanId,
      expectedAccessRevision: memberResolution.resolution.artifact.accessRevision,
      access: 'revoked',
      requestId: 'revoke-result-link-reader',
    });
    expect((await resolve(member.sessionToken)).status).toBe(403);
  } finally {
    await server.close();
  }
});

it('refuses a no-longer-current Work result file before any owner publication effect', async () => {
  const f = await admittedWorkWithFileFixture();
  const result = await f.store.postAgentMessage(f.connection.endpointCredential, f.legacyResult);
  await f.store.bindAcceptedWorkResultFile(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    resultEventId: result.eventId,
    workResultFile: f.workResultFile,
  });
  const ready = f.store
    .listCollectiveCollaboration(f.owner.sessionToken, f.coordinates.collectiveId)
    .works.find((candidate) => candidate.workId === f.work.workId);
  if (!ready) throw new Error('Expected current Work');
  await f.store.requestCollectiveWorkRevision(f.owner.sessionToken, {
    ...f.coordinates,
    workId: ready.workId,
    expectedRevision: ready.revision,
    requestId: 'supersede-result-before-promotion',
    resultEventId: result.eventId,
    resultRevision: 1,
    feedback: 'Please return the revised document.',
  });
  await expect(
    f.store.promoteWorkResultArtifact(f.owner.sessionToken, {
      ...f.coordinates,
      fileId: f.fileId,
    }),
  ).rejects.toMatchObject({ code: 'ARTIFACT_ACCESS_DENIED' });
});

it('revalidates a prepared Work result until the owner publication effect is admitted', async () => {
  const f = await admittedWorkWithFileFixture();
  const result = await f.store.postAgentMessage(f.connection.endpointCredential, f.legacyResult);
  await f.store.bindAcceptedWorkResultFile(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    resultEventId: result.eventId,
    workResultFile: f.workResultFile,
  });
  const promotion = f.store.promoteWorkResultArtifact(f.owner.sessionToken, {
    ...f.coordinates,
    fileId: f.fileId,
  });
  const outcome = promotion.then(
    (publication) => ({ status: 'published' as const, publication }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );
  let prepared: Awaited<ReturnType<typeof f.store.pollArtifactPublications>>[number] | undefined;
  for (let attemptIndex = 0; attemptIndex < 40 && !prepared; attemptIndex += 1) {
    prepared = (
      await f.store.pollArtifactPublications(f.connection.endpointCredential, {
        ...f.coordinates,
        connectionId: f.connection.connectionId,
      })
    )[0];
    if (!prepared) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(prepared).toBeTruthy();
  const ready = f.store
    .listCollectiveCollaboration(f.owner.sessionToken, f.coordinates.collectiveId)
    .works.find((candidate) => candidate.workId === f.work.workId);
  if (!ready) throw new Error('Expected current Work');
  await f.store.requestCollectiveWorkRevision(f.owner.sessionToken, {
    ...f.coordinates,
    workId: ready.workId,
    expectedRevision: ready.revision,
    requestId: 'supersede-prepared-result-before-owner-admission',
    resultEventId: result.eventId,
    resultRevision: 1,
    feedback: 'Please return the revised document.',
  });
  expect(
    await f.store.pollArtifactPublications(f.connection.endpointCredential, {
      ...f.coordinates,
      connectionId: f.connection.connectionId,
    }),
  ).toEqual([]);
  const rejected = await outcome;
  expect(rejected.status).toBe('rejected');
  if (rejected.status !== 'rejected') throw new Error('Expected stale publication to fail');
  expect(rejected.error).toMatchObject({ code: 'ARTIFACT_ACCESS_DENIED' });
});

it('keeps plain-text Work results readable but outside the SharedArtifact promotion lane', async () => {
  const f = await admittedWorkWithFileFixture();
  const bytes = Buffer.from('Plain text result\n');
  const contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const fileName = `cwork-${contentDigest.slice('sha256:'.length)}.txt`;
  const sourceHref = `/uploads/${fileName}`;
  const fileId = `wrf_${'e'.repeat(64)}`;
  const result = await f.store.postAgentMessage(f.connection.endpointCredential, {
    ...f.legacyResult,
    clientEventId: 'plain-text-result',
    body: `Plain result: [open text](${sourceHref}).`,
  });
  await f.store.bindAcceptedWorkResultFile(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    resultEventId: result.eventId,
    workResultFile: {
      v: 1,
      fileId,
      sourceHref,
      fileName,
      mediaType: 'text/plain',
      contentDigest,
      byteLength: bytes.length,
      contentBase64: bytes.toString('base64'),
    },
  });
  expect(f.store.readWorkResultFile(f.owner.sessionToken, fileId, fileName).bytes).toEqual(bytes);
  const server = await startCollectiveServer({ store: f.store, host: '127.0.0.1', port: 0 });
  try {
    const response = await fetch(`${server.url}${collectiveWorkResultFilePath({ fileId, fileName })}`, {
      headers: { authorization: `Bearer ${f.owner.sessionToken}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  } finally {
    await server.close();
  }
  await expect(
    f.store.promoteWorkResultArtifact(f.owner.sessionToken, {
      ...f.coordinates,
      fileId,
    }),
  ).rejects.toMatchObject({ code: 'WORK_RESULT_ARTIFACT_UNSUPPORTED' });
});

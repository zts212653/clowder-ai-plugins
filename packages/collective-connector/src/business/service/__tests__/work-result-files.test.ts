import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectiveWorkResultFilePath } from '../../contracts/index.js';
import { expect, it } from 'vitest';
import { startCollectiveServer } from '../http-server.js';
import { SERVICE_STATE_FILE } from '../persistence.js';
import { CollectiveServiceStore } from '../store.js';
import { fixture } from './communication-acceptance.fixture.js';
import { admittedWorkWithFileFixture } from './work-result-file.fixture.js';

it('persists only an exact current Work result file and rechecks Collective membership on every read', async () => {
  const f = await fixture();
  await f.store.registerCollectiveWorkPolicy(f.owner.sessionToken, f.policyInput);
  const work = await f.store.acceptCollectiveWorkAsAgent(f.connection.endpointCredential, f.acceptance);
  await f.store.recordCollectiveWorkHostAdmission(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    workId: work.workId,
    assignmentEventId: work.assignmentEventId,
    operationRef: f.acceptance.requestId,
    grantRef: 'grant-guides',
    grantRevision: 1,
    disposition: { state: 'admitted', receiptRef: 'host:result-file-task' },
  });
  const bytes = Buffer.from('# 共同作品接力指南\n\n完成后，把结果贴这里。\n');
  const contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const fileName = `cwork-${contentDigest.slice('sha256:'.length)}.md`;
  const fileId = `wrf_${'a'.repeat(64)}`;
  const serviceOrigin = 'http://collective.test';
  const publicHref = new URL(collectiveWorkResultFilePath({ fileId, fileName }), serviceOrigin).toString();
  const result = {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    clientEventId: 'result-with-public-file',
    participationRevision: 1,
    agent: { agentId: 'codex-sol', catId: 'codex-sol', displayName: 'Sol', sessionRef: 'result-file-turn' },
    target: { kind: 'message' as const, eventId: work.assignmentEventId },
    replyToEventId: work.assignmentEventId,
    workResultIntent: {
      assignmentEventId: work.assignmentEventId,
      assignmentCatId: 'codex-sol',
      participationRevision: 1,
      resultRevision: 1,
    },
    workResultFile: {
      v: 1 as const,
      fileId,
      sourceHref: `/uploads/${fileName}`,
      fileName,
      mediaType: 'text/markdown' as const,
      contentDigest,
      byteLength: bytes.length,
      contentBase64: bytes.toString('base64'),
    },
    body: `第1版：[打开或下载 Markdown 文件](${publicHref})。`,
  };

  await expect(
    f.store.postAgentMessage(
      f.connection.endpointCredential,
      {
        ...result,
        workResultFile: { ...result.workResultFile, contentBase64: Buffer.from('changed').toString('base64') },
      },
      serviceOrigin,
    ),
  ).rejects.toMatchObject({ code: 'WORK_RESULT_FILE_INVALID' });
  await expect(
    f.store.postAgentMessage(
      f.connection.endpointCredential,
      { ...result, workResultFile: { ...result.workResultFile, mediaType: 'text/plain' } },
      serviceOrigin,
    ),
  ).rejects.toMatchObject({ code: 'WORK_RESULT_FILE_INVALID' });
  const invalidUtf8 = Buffer.from([0xc3, 0x28]);
  const invalidUtf8Digest = `sha256:${createHash('sha256').update(invalidUtf8).digest('hex')}`;
  const invalidUtf8FileName = `cwork-${invalidUtf8Digest.slice('sha256:'.length)}.md`;
  const invalidUtf8FileId = `wrf_${'b'.repeat(64)}`;
  const invalidUtf8Href = new URL(
    collectiveWorkResultFilePath({ fileId: invalidUtf8FileId, fileName: invalidUtf8FileName }),
    serviceOrigin,
  ).toString();
  await expect(
    f.store.postAgentMessage(
      f.connection.endpointCredential,
      {
        ...result,
        clientEventId: 'result-with-invalid-utf8-file',
        body: `无效文本：[打开](${invalidUtf8Href})。`,
        workResultFile: {
          ...result.workResultFile,
          fileId: invalidUtf8FileId,
          sourceHref: `/uploads/${invalidUtf8FileName}`,
          fileName: invalidUtf8FileName,
          contentDigest: invalidUtf8Digest,
          byteLength: invalidUtf8.length,
          contentBase64: invalidUtf8.toString('base64'),
        },
      },
      serviceOrigin,
    ),
  ).rejects.toMatchObject({ code: 'WORK_RESULT_FILE_INVALID' });
  await expect(
    f.store.postAgentMessage(
      f.connection.endpointCredential,
      { ...result, body: result.body.replace(serviceOrigin, 'https://files.example') },
      serviceOrigin,
    ),
  ).rejects.toMatchObject({ code: 'WORK_RESULT_FILE_INVALID' });
  const server = await startCollectiveServer({
    store: f.store,
    host: '127.0.0.1',
    port: 0,
    publicUrl: serviceOrigin,
  });
  const accepted = await (async () => {
    try {
      return await fetch(`${server.url}/api/events/agent`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${f.connection.endpointCredential}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(result),
      });
    } finally {
      await server.close();
    }
  })();
  expect(accepted.status).toBe(201);
  const event = (await accepted.json()) as Awaited<ReturnType<typeof f.store.postAgentMessage>>;
  expect(event.body).toContain(publicHref);
  expect(f.store.readWorkResultFile(f.owner.sessionToken, fileId, fileName).bytes).toEqual(bytes);
  const reopened = await CollectiveServiceStore.open({
    dataDirectory: f.directory,
    humanAuthProvider: f.humanAuthProvider,
  });
  expect(reopened.store.readWorkResultFile(f.owner.sessionToken, fileId, fileName).bytes).toEqual(bytes);
  await expect(f.store.postAgentMessage(f.connection.endpointCredential, result, serviceOrigin)).resolves.toEqual(
    event,
  );
  const { workResultFile: _file, ...missingFileReplay } = result;
  await expect(
    f.store.postAgentMessage(f.connection.endpointCredential, missingFileReplay, serviceOrigin),
  ).rejects.toMatchObject({ code: 'CLIENT_EVENT_CONFLICT' });

  const invite = await f.store.createInvite({
    sessionToken: f.owner.sessionToken,
    collectiveId: f.coordinates.collectiveId,
  });
  const attempt = await f.store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
  });
  const completion = await f.store.completeHumanAuth({ provider: 'github', state: attempt.state, code: 'member' });
  const member = await f.store.exchangeHumanAuthCompletion(completion.completionToken);
  expect(f.store.readWorkResultFile(member.sessionToken, fileId, fileName).bytes).toEqual(bytes);
  await f.store.leaveCollective({ sessionToken: member.sessionToken, collectiveId: f.coordinates.collectiveId });
  expect(() => f.store.readWorkResultFile(member.sessionToken, fileId, fileName)).toThrow(
    expect.objectContaining({ code: 'FORBIDDEN' }),
  );
});

it('binds exact bytes to an already accepted legacy Work result without creating a new event or result revision', async () => {
  const f = await admittedWorkWithFileFixture();
  expect(f.bytes).toHaveLength(684);
  expect(f.contentDigest).toBe('sha256:919da31dc54c2680063ffe4fb02113313abcd606fac0ec66c656cb759d6f2059');
  const accepted = await f.store.postAgentMessage(f.connection.endpointCredential, f.legacyResult);
  const before = await f.store.listEventsForHuman(f.owner.sessionToken, f.coordinates.collectiveId);
  expect(before.at(-1)).toEqual(accepted);
  expect(accepted.body).toContain(`](${f.sourceHref})`);

  const binding = {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    resultEventId: accepted.eventId,
    workResultFile: f.workResultFile,
  };
  await expect(f.store.bindAcceptedWorkResultFile(f.connection.endpointCredential, binding)).resolves.toMatchObject({
    resultEventId: accepted.eventId,
    fileId: f.fileId,
  });
  await expect(
    f.store.bindAcceptedWorkResultFile(f.connection.endpointCredential, {
      ...binding,
      workResultFile: { ...f.workResultFile, fileId: `wrf_${'d'.repeat(64)}` },
    }),
  ).rejects.toMatchObject({ code: 'CLIENT_EVENT_CONFLICT' });
  await expect(f.store.bindAcceptedWorkResultFile(f.connection.endpointCredential, binding)).resolves.toMatchObject({
    resultEventId: accepted.eventId,
    fileId: f.fileId,
  });

  const after = await f.store.listEventsForHuman(f.owner.sessionToken, f.coordinates.collectiveId);
  expect(after).toHaveLength(before.length);
  expect(after.at(-1)).toMatchObject({
    eventId: accepted.eventId,
    clientEventId: accepted.clientEventId,
    workResultReceipt: accepted.workResultReceipt,
  });
  expect(after.at(-1)?.body).toContain(collectiveWorkResultFilePath(f.workResultFile));
  expect(after.at(-1)?.body).not.toContain(`](${f.sourceHref})`);
  const persisted = JSON.parse(await readFile(join(f.directory, SERVICE_STATE_FILE), 'utf8')) as {
    events: Record<string, Array<{ eventId: string; body: string }>>;
  };
  expect(
    persisted.events[f.coordinates.collectiveId]?.find((event) => event.eventId === accepted.eventId)?.body,
  ).toContain(`](${f.sourceHref})`);
  expect(f.store.readWorkResultFile(f.owner.sessionToken, f.fileId, f.fileName).bytes).toEqual(f.bytes);
  expect(
    f.store
      .listCollectiveCollaboration(f.owner.sessionToken, f.coordinates.collectiveId)
      .works.find((candidate) => candidate.workId === f.work.workId),
  ).toMatchObject({ resultEventId: accepted.eventId, resultRevision: 1, lifecycle: 'result_ready' });
});

it('uses the configured Human auth origin rather than an untrusted Host header for agent result addresses', async () => {
  const f = await admittedWorkWithFileFixture();
  const trustedOrigin = new URL(f.store.getHumanAuthRedirectUri()).origin;
  const body = `第1版：[打开或下载 Markdown 文件](${new URL(
    collectiveWorkResultFilePath(f.workResultFile),
    trustedOrigin,
  )})。`;
  const server = await startCollectiveServer({ store: f.store, host: '127.0.0.1', port: 0 });
  try {
    const response = await fetch(`${server.url}/api/events/agent`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${f.connection.endpointCredential}`,
        'content-type': 'application/json',
        host: 'attacker.invalid',
      },
      body: JSON.stringify({ ...f.legacyResult, body, workResultFile: f.workResultFile }),
    });
    expect(response.status).toBe(201);
    expect((await response.json()) as { body: string }).toMatchObject({ body });
  } finally {
    await server.close();
  }
});

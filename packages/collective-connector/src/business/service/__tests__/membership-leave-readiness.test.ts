import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { collectiveMembershipLeaveReadinessSchema } from '../../contracts/index.js';
import { participationFixture } from './participation-fixture.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'collective-membership-leave-readiness-'));
  directories.push(directory);
  return { ...(await participationFixture(directory)), directory };
}

async function inviteMember(current: Awaited<ReturnType<typeof fixture>>, identity: string) {
  const invite = await current.store.createInvite({
    sessionToken: current.owner.sessionToken,
    collectiveId: current.coordinates.collectiveId,
  });
  const attempt = await current.store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
  });
  const completion = await current.store.completeHumanAuth({
    provider: 'github',
    state: attempt.state,
    code: identity,
  });
  const member = await current.store.exchangeHumanAuthCompletion(completion.completionToken);
  const pairing = await current.store.createPairingIntent({
    sessionToken: member.sessionToken,
    collectiveId: current.coordinates.collectiveId,
    hostOrigin: 'http://localhost:5189',
    nonce: `${identity}-leave-readiness-nonce`,
  });
  const connection = await current.store.exchangePairingIntent({
    ...pairing,
    endpointLabel: `${identity} Café`,
  });
  return { member, connection };
}

it('reports that a steward needs unsupported governance handoff without inventing an action', async () => {
  const current = await fixture();
  expect(
    current.store.readMembershipLeaveReadiness(current.owner.sessionToken, current.coordinates.collectiveId),
  ).toMatchObject({
    role: 'steward',
    governanceHandoffRequired: true,
    canLeave: false,
  });
});

it('lists every readable responsibility while withholding an inaccessible custodied title', async () => {
  const current = await fixture();
  const { member, connection } = await inviteMember(current, 'readiness-member');
  const project = await current.store.createCollectiveProject(member.sessionToken, {
    ...current.coordinates,
    requestId: 'readiness-project',
    channelId: 'general',
    title: '离开前要处理的项目',
    purpose: '确认成员能看清未结责任。',
  });
  const created = await current.store.createCollectiveProjectTask(member.sessionToken, {
    ...current.coordinates,
    requestId: 'readiness-task',
    roadmapId: project.roadmapId,
    expectedRoadmapRevision: project.revision,
    channelId: 'general',
    title: '离开前要处理的任务',
    intendedOutcome: '处理后才能退出共同体。',
    accountability: 'self',
  });
  const visible = await current.store.registerArtifact(connection.endpointCredential, {
    ...current.coordinates,
    connectionId: connection.connectionId,
    contentRef: 'content:visible-leave-artifact',
    title: '可返回处理的托管作品',
    mediaType: 'text/markdown',
    sourceEventId: created.work.sourceEventId,
    workId: created.work.workId,
    ownerRevision: 1,
    blobDigest: `sha256:${'a'.repeat(64)}`,
    receiptRef: 'receipt:visible-leave-artifact',
    requestId: 'register-visible-leave-artifact',
  });
  const hidden = await current.store.registerArtifact(connection.endpointCredential, {
    ...current.coordinates,
    connectionId: connection.connectionId,
    contentRef: 'content:hidden-leave-artifact',
    title: '绝不能泄露的作品标题',
    mediaType: 'text/markdown',
    sourceEventId: created.work.sourceEventId,
    workId: created.work.workId,
    ownerRevision: 1,
    blobDigest: `sha256:${'b'.repeat(64)}`,
    receiptRef: 'receipt:hidden-leave-artifact',
    requestId: 'register-hidden-leave-artifact',
  });
  await current.store.updateArtifactAccess(member.sessionToken, {
    ...current.coordinates,
    artifactId: hidden.artifactId,
    humanId: member.human.humanId,
    expectedAccessRevision: hidden.accessRevision,
    requestId: 'hide-leave-artifact-from-custodian',
    access: 'revoked',
  });

  const readiness = current.store.readMembershipLeaveReadiness(
    member.sessionToken,
    current.coordinates.collectiveId,
  );
  expect(collectiveMembershipLeaveReadinessSchema.parse(readiness)).toMatchObject({
    role: 'member',
    membershipRevision: 1,
    governanceHandoffRequired: false,
    canLeave: false,
    responsibilities: {
      works: [
        {
          workId: created.work.workId,
          title: '离开前要处理的任务',
          status: 'ready',
          source: { eventId: created.work.sourceEventId, location: { channelId: 'general' } },
          projects: [
            {
              roadmapId: project.roadmapId,
              title: '离开前要处理的项目',
              source: { eventId: project.sourceEventId, location: { channelId: 'general' } },
            },
          ],
        },
      ],
      roadmaps: [
        {
          roadmapId: project.roadmapId,
          title: '离开前要处理的项目',
          source: { eventId: project.sourceEventId, location: { channelId: 'general' } },
        },
      ],
      artifacts: {
        items: [
          {
            kind: 'artifact',
            artifactId: visible.artifactId,
            title: '可返回处理的托管作品',
            ownerRevision: 1,
            source: { eventId: created.work.sourceEventId, location: { channelId: 'general' } },
          },
        ],
        inaccessibleCount: 1,
      },
    },
  });
  expect(JSON.stringify(readiness)).not.toContain('绝不能泄露的作品标题');
  expect(JSON.stringify(readiness)).not.toContain(hidden.artifactId);
});

it('includes an admitted pending publication in the same custody blocker projection', async () => {
  const current = await fixture();
  const { member, connection } = await inviteMember(current, 'pending-publication-member');
  const source = await current.store.postHumanMessage(member.sessionToken, {
    ...current.coordinates,
    clientEventId: 'pending-publication-source',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: '这份待发布作品必须先结清。',
  });
  const bytes = Buffer.from('# Pending publication');
  const publication = await current.store.prepareArtifactPublication(member.sessionToken, {
    ...current.coordinates,
    connectionId: connection.connectionId,
    sourceEventId: source.eventId,
    requestId: 'pending-leave-publication',
    title: '尚在发布的作品',
    blobDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  });
  const waiting = current.store
    .sendArtifactPublication(member.sessionToken, {
      publicationId: publication.publicationId,
      bytesBase64: bytes.toString('base64'),
    })
    .catch((error: unknown) => error);
  const operation = (
    await current.store.pollArtifactPublications(connection.endpointCredential, {
      ...current.coordinates,
      connectionId: connection.connectionId,
    })
  )[0];
  expect(operation).toBeTruthy();
  if (!operation) throw new Error('Expected pending publication operation');
  await current.store.validateArtifactPublication(connection.endpointCredential, {
    ...current.coordinates,
    connectionId: connection.connectionId,
    publicationId: publication.publicationId,
    relayRef: operation.relayRef,
  });

  expect(
    current.store.readMembershipLeaveReadiness(member.sessionToken, current.coordinates.collectiveId),
  ).toMatchObject({
    canLeave: false,
    responsibilities: {
      artifacts: {
        items: [
          {
            kind: 'publication',
            publicationId: publication.publicationId,
            title: '尚在发布的作品',
            source: { eventId: source.eventId, location: { channelId: 'general' } },
          },
        ],
        inaccessibleCount: 0,
      },
    },
  });
  await expect(
    current.store.leaveCollective({
      sessionToken: member.sessionToken,
      collectiveId: current.coordinates.collectiveId,
    }),
  ).rejects.toMatchObject({ code: 'ARTIFACT_CUSTODY_HANDOFF_REQUIRED' });
  current.store.stopArtifactOwnerRelay();
  expect(await waiting).toMatchObject({ code: 'ARTIFACT_OWNER_UNAVAILABLE' });
});

it('rechecks responsibilities inside the leave transaction after a ready read', async () => {
  const current = await fixture();
  const { member, connection } = await inviteMember(current, 'concurrent-readiness-member');
  expect(
    current.store.readMembershipLeaveReadiness(member.sessionToken, current.coordinates.collectiveId),
  ).toMatchObject({
    canLeave: true,
    responsibilities: {
      works: [],
      roadmaps: [],
      artifacts: { items: [], inaccessibleCount: 0 },
    },
  });

  await current.store.createCollectiveProject(member.sessionToken, {
    ...current.coordinates,
    requestId: 'late-readiness-project',
    channelId: 'general',
    title: '查询后新增的责任',
    purpose: '真正退出必须重新检查。',
  });

  await expect(
    current.store.leaveCollective({
      sessionToken: member.sessionToken,
      collectiveId: current.coordinates.collectiveId,
    }),
  ).rejects.toMatchObject({ code: 'MEMBERSHIP_RESPONSIBILITY_REQUIRED' });
  expect(await current.store.getConnectionProjection(connection.connectionId)).toMatchObject({ status: 'connected' });
});

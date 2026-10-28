import { expect, it } from 'vitest';
import { CollectiveServiceClient } from '../../connector/service-client.js';
import { collectiveProjectSourceReadSchema } from '../../contracts/types/collective-project-source.js';
import { CollectiveServiceStore } from '../store.js';
import { projectArtifactFixture as fixture } from './project-artifact.fixture.js';

it('restores the same reference and exact version after read permission returns, then removes and reattaches without changing B or the source', async () => {
  const f = await fixture();
  const attach = { action: 'attach', expectedRevision: 0, requestId: 'restore-attach', versionRef: f.versionRef(f.v2) };
  const initial = await f.change(f.b.roadmapId, f.member.sessionToken, attach);
  await f.change(f.a.roadmapId, f.owner.sessionToken, { ...attach, requestId: 'other-project' });
  await f.store.revokeArtifactAccess(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    humanId: f.member.human.humanId,
    expectedAccessRevision: 1,
    requestId: 'revoke-then-restore',
  });
  expect((await f.list(f.b.roadmapId, f.member.sessionToken)).value).toMatchObject({
    items: [{ availability: 'access_denied' }],
  });
  await f.store.updateArtifactAccess(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    humanId: f.member.human.humanId,
    expectedAccessRevision: 2,
    requestId: 'restore-reader',
    access: 'read',
  });
  const restored = await f.list(f.b.roadmapId, f.member.sessionToken);
  expect(restored.value).toMatchObject({
    items: [{ availability: 'available', reference: initial.value.item.reference }],
  });
  await f.change(f.b.roadmapId, f.member.sessionToken, {
    action: 'remove',
    expectedRevision: 1,
    requestId: 'remove-b',
  });
  expect((await f.list(f.b.roadmapId, f.member.sessionToken)).value).toMatchObject({
    items: [],
    removedReferences: [{ artifactId: f.artifact.artifactId, revision: 2 }],
  });
  expect(
    (
      await f.change(f.b.roadmapId, f.member.sessionToken, {
        ...attach,
        expectedRevision: 2,
        requestId: 'reattach-b',
        versionRef: f.versionRef(f.v3),
      })
    ).value,
  ).toMatchObject({
    item: {
      reference: { referenceId: initial.value.item.reference.referenceId, revision: 3, versionRef: f.versionRef(f.v3) },
    },
  });
  expect((await f.list(f.a.roadmapId)).value).toMatchObject({
    items: [{ reference: { versionRef: f.versionRef(f.v2) } }],
  });
  expect(f.store.listArtifacts(f.owner.sessionToken, f.coordinates)[0]?.versionCount).toBe(3);
  const reopened = await CollectiveServiceStore.open({
    dataDirectory: f.directory,
    humanAuthProvider: f.humanAuthProvider,
  });
  // A stopped relay hides bytes, but persistence retains identity, history and the exact pin across process restart.
  reopened.store.stopArtifactOwnerRelay();
  expect(
    await reopened.store.listProjectArtifactReferences(f.member.sessionToken, {
      ...f.coordinates,
      roadmapId: f.b.roadmapId,
    }),
  ).toMatchObject({
    items: [
      {
        reference: {
          referenceId: initial.value.item.reference.referenceId,
          revision: 3,
          versionRef: f.versionRef(f.v3),
          history: [{ action: 'attach' }, { action: 'remove' }, { action: 'attach' }],
        },
      },
    ],
  });
});

it('does not expose projects outside the current Collective or infer original identity from a matching title', async () => {
  const f = await fixture();
  const privateCollective = await f.store.createCollective({
    sessionToken: f.owner.sessionToken,
    name: 'Only the owner belongs here',
  });
  const privateCoordinates = {
    serviceInstanceId: f.coordinates.serviceInstanceId,
    collectiveId: privateCollective.collectiveId,
  };
  const privateProject = await f.store.createCollectiveProject(f.owner.sessionToken, {
    ...privateCoordinates,
    requestId: 'other-collective-project',
    channelId: 'general',
    title: '绝不能泄漏的项目名',
    purpose: '保持共同体权限隔离',
  });
  await f.change(f.b.roadmapId, f.member.sessionToken, {
    action: 'attach',
    expectedRevision: 0,
    requestId: 'public-reference',
    versionRef: f.versionRef(f.v3),
  });
  const projection = await f.list(f.b.roadmapId, f.member.sessionToken);
  expect(projection.value.items[0].usedBy).toHaveLength(1);
  expect(JSON.stringify(projection.value)).not.toContain(privateProject.title);
  expect((await f.list(privateProject.roadmapId, f.member.sessionToken)).status).toBe(404);
  expect(
    (
      await f.post('/api/collaboration/projects/artifacts/list', f.member.sessionToken, {
        ...privateCoordinates,
        roadmapId: privateProject.roadmapId,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.post('/api/collaboration/projects/artifacts/change', f.owner.sessionToken, {
        ...privateCoordinates,
        roadmapId: privateProject.roadmapId,
        artifactId: f.artifact.artifactId,
        action: 'attach',
        expectedRevision: 0,
        requestId: 'cannot-borrow-other-collective-identity',
        versionRef: f.versionRef(f.v2),
      })
    ).status,
  ).toBe(404);
});

it('lets a declared Channel Cat discover exact authorized project pins without gaining replacement or body authority', async () => {
  const f = await fixture();
  await f.change(f.a.roadmapId, f.owner.sessionToken, {
    action: 'attach',
    expectedRevision: 0,
    requestId: 'cat-visible-pin',
    versionRef: f.versionRef(f.v2),
  });
  const declaration = await f.store.publishParticipation(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    revision: 1,
    agents: [{ catId: 'reader-cat', displayName: 'Reader', channelIds: ['general'] }],
  });
  const scope = {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    sourceEventId: f.a.sourceEventId,
    catId: 'reader-cat',
    participationRevision: declaration.revision,
  };
  const read = () =>
    new CollectiveServiceClient().readProjectSource(f.server.url, f.connection.endpointCredential, scope);
  expect((await read()).projects.find((project) => project.roadmapId === f.a.roadmapId)).toMatchObject({
    artifactReferences: [
      { artifactId: f.artifact.artifactId, sourceEventId: f.artifact.sourceEventId, versionRef: f.versionRef(f.v2) },
    ],
  });
  expect(JSON.stringify(await read())).not.toContain(f.artifact.title);
  const legacy = await f.post('/api/collaboration/project-source', f.connection.endpointCredential, scope);
  expect(legacy.value.projects[0]).not.toHaveProperty('artifactReferences');
  expect(legacy.value.projects[0]).not.toHaveProperty('artifactReferencesHaveMore');
  expect(collectiveProjectSourceReadSchema.parse(legacy.value)).toEqual(legacy.value);
  await f.store.revokeArtifactAccess(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    humanId: f.owner.human.humanId,
    expectedAccessRevision: 1,
    requestId: 'revoke-cat-owner-read',
  });
  expect((await read()).projects.find((project) => project.roadmapId === f.a.roadmapId)).toMatchObject({
    artifactReferences: [],
  });
});

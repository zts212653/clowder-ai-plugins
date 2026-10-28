import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { collectiveProjectArtifactChangeSchema } from '../../contracts/index.js';
import { CollectiveServiceStore } from '../store.js';
import { projectArtifactFixture as fixture } from './project-artifact.fixture.js';

it('pins one original to A v2 and B v3; a source v4 never changes either until A explicitly switches', async () => {
  const f = await fixture();
  const first = await f.change(f.a.roadmapId, f.owner.sessionToken, {
    action: 'attach',
    expectedRevision: 0,
    requestId: 'attach-a',
    versionRef: f.versionRef(f.v2),
  });
  expect(first.status).toBe(200);
  expect(first.value).toMatchObject({
    outcome: 'changed',
    item: { reference: { revision: 1, versionRef: f.versionRef(f.v2) } },
  });
  await f.change(f.b.roadmapId, f.member.sessionToken, {
    action: 'attach',
    expectedRevision: 0,
    requestId: 'attach-b',
    versionRef: f.versionRef(f.v3),
  });
  const v4 = await f.publish(4);
  expect((await f.list(f.a.roadmapId)).value).toMatchObject({
    items: [
      {
        reference: { versionRef: f.versionRef(f.v2) },
        latestVersionRef: f.versionRef(v4),
        hasUpdate: true,
        usedBy: expect.arrayContaining([
          {
            roadmapId: f.b.roadmapId,
            title: f.b.title,
            accountableHumanId: f.member.human.humanId,
            versionRef: f.versionRef(f.v3),
          },
        ]),
      },
    ],
  });
  expect((await f.list(f.b.roadmapId)).value).toMatchObject({
    items: [{ reference: { versionRef: f.versionRef(f.v3) } }],
  });
  const change = { action: 'switch', expectedRevision: 1, requestId: 'switch-a', versionRef: f.versionRef(v4) };
  expect((await f.change(f.a.roadmapId, f.owner.sessionToken, change)).value).toMatchObject({
    outcome: 'changed',
    item: {
      reference: {
        revision: 2,
        versionRef: f.versionRef(v4),
        history: [
          { action: 'attach', sourceEventId: expect.any(String) },
          { action: 'switch', previousVersionRef: f.versionRef(f.v2) },
        ],
      },
    },
  });
  expect((await f.change(f.a.roadmapId, f.owner.sessionToken, change)).value).toMatchObject({ outcome: 'replayed' });
  expect((await f.list(f.b.roadmapId)).value).toMatchObject({
    items: [{ reference: { revision: 1, versionRef: f.versionRef(f.v3) } }],
  });
  const reopened = await CollectiveServiceStore.open({
    dataDirectory: f.directory,
    humanAuthProvider: f.humanAuthProvider,
  });
  expect(reopened.store.listArtifacts(f.owner.sessionToken, f.coordinates)[0]?.versionCount).toBe(4);
});

it('requires the project owner, exact immutable version identity, CAS and idempotency across keep, switch and remove', async () => {
  const f = await fixture(),
    attach = { action: 'attach', expectedRevision: 0, requestId: 'attach', versionRef: f.versionRef(f.v2) };
  expect((await f.change(f.a.roadmapId, f.member.sessionToken, attach)).status).toBe(403);
  expect((await f.change(f.a.roadmapId, f.connection.endpointCredential, attach)).status).toBe(401);
  expect(
    (
      await f.change(f.a.roadmapId, f.owner.sessionToken, {
        ...attach,
        versionRef: { ...f.versionRef(f.v2), receiptRef: 'forged' },
      })
    ).status,
  ).toBe(409);
  await f.change(f.a.roadmapId, f.owner.sessionToken, attach);
  expect(
    (
      await f.change(f.a.roadmapId, f.owner.sessionToken, {
        action: 'keep',
        expectedRevision: 1,
        requestId: 'keep-v3',
        versionRef: f.versionRef(f.v3),
      })
    ).value,
  ).toMatchObject({
    outcome: 'changed',
    item: { hasUpdate: false, reference: { revision: 2, versionRef: f.versionRef(f.v2) } },
  });
  const v4 = await f.publish(4);
  expect((await f.list(f.a.roadmapId)).value).toMatchObject({ items: [{ hasUpdate: true }] });
  const versions = [f.v3, v4];
  const requests = versions.map((version, index) => ({
    action: 'switch',
    expectedRevision: 2,
    requestId: `concurrent-${index}`,
    versionRef: f.versionRef(version),
  }));
  const results = await Promise.all(
    requests.map((request) => f.change(f.a.roadmapId, f.owner.sessionToken, request)),
  );
  expect(results.map((result) => result.status)).toEqual([200, 200]);
  const replies = results.map((result) => collectiveProjectArtifactChangeSchema.parse(result.value));
  expect(replies.map((reply) => reply.outcome).sort()).toEqual(['changed', 'conflict']);
  // Owner probes are asynchronous; either request can reach the CAS transaction first.
  const winnerIndex = replies.findIndex((reply) => reply.outcome === 'changed');
  const winner = replies[winnerIndex]!;
  expect(winner.item?.reference).toMatchObject({
    revision: 3,
    versionRef: f.versionRef(versions[winnerIndex]!),
  });
  expect(replies.find((reply) => reply.outcome === 'conflict')?.item?.reference).toEqual(winner.item?.reference);
  expect((await f.list(f.a.roadmapId)).value.items[0]?.reference).toEqual(winner.item?.reference);
  expect((await f.change(f.a.roadmapId, f.owner.sessionToken, requests[winnerIndex]!)).value).toMatchObject({
    outcome: 'replayed',
    item: { reference: winner.item?.reference },
  });
  expect(
    (await f.change(f.a.roadmapId, f.owner.sessionToken, { ...attach, versionRef: f.versionRef(v4) })).status,
  ).toBe(409);
  expect(
    (
      await f.change(f.a.roadmapId, f.owner.sessionToken, {
        action: 'remove',
        expectedRevision: 3,
        requestId: 'remove',
      })
    ).value,
  ).toMatchObject({ outcome: 'changed', item: { reference: { status: 'removed' } } });
  expect((await f.list(f.a.roadmapId)).value).toMatchObject({ items: [] });
  expect(f.store.listArtifacts(f.owner.sessionToken, f.coordinates)[0]?.versionCount).toBe(4);
  const reopened = await CollectiveServiceStore.open({
    dataDirectory: f.directory,
    humanAuthProvider: f.humanAuthProvider,
  });
  expect(
    reopened.store.listCollectiveCollaboration(f.owner.sessionToken, f.coordinates.collectiveId).works,
  ).toHaveLength(0);
});

it('retains unreadable references without title or content and old snapshots load without a reference field', async () => {
  const f = await fixture();
  await f.change(f.b.roadmapId, f.member.sessionToken, {
    action: 'attach',
    expectedRevision: 0,
    requestId: 'member-attach',
    versionRef: f.versionRef(f.v2),
  });
  const revoked = await f.store.revokeArtifactAccess(f.owner.sessionToken, {
    ...f.coordinates,
    artifactId: f.artifact.artifactId,
    humanId: f.member.human.humanId,
    expectedAccessRevision: 1,
    requestId: 'revoke-member',
  });
  expect(revoked).toBeTruthy();
  const denied = await f.list(f.b.roadmapId, f.member.sessionToken);
  expect(denied.status).toBe(200);
  expect(denied.value).toMatchObject({
    items: [{ availability: 'access_denied', reference: { versionRef: f.versionRef(f.v2) } }],
  });
  expect(JSON.stringify(denied.value)).not.toContain(f.artifact.title);
  const path = join(f.directory, 'collective-service.json');
  const old = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  delete old.projectArtifactReferences;
  await writeFile(path, JSON.stringify(old));
  const reopened = await CollectiveServiceStore.open({
    dataDirectory: f.directory,
    humanAuthProvider: f.humanAuthProvider,
  });
  expect(
    reopened.store.listCollectiveCollaboration(f.owner.sessionToken, f.coordinates.collectiveId).roadmaps,
  ).toHaveLength(2);
});

it('does not advertise a connected but unreachable original owner as readable', async () => {
  const f = await fixture();
  await f.change(f.a.roadmapId, f.owner.sessionToken, {
    action: 'attach',
    expectedRevision: 0,
    requestId: 'attach-outage',
    versionRef: f.versionRef(f.v2),
  });
  f.store.stopArtifactOwnerRelay();
  const unavailable = await f.list(f.a.roadmapId);
  expect(unavailable.status).toBe(200);
  expect(unavailable.value).toMatchObject({
    items: [{ availability: 'owner_unavailable', reference: { versionRef: f.versionRef(f.v2) } }],
  });
  expect(JSON.stringify(unavailable.value)).not.toContain(f.artifact.title);
});

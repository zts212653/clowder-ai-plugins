import { expect, it } from 'vitest';
import { projectArtifactFixture } from './project-artifact.fixture.js';

it('keeps distinct original identities with identical names and bytes, and rejects a changed reference-page snapshot', async () => {
  const f = await projectArtifactFixture();
  for (let index = 0; index < 31; index++) {
    const artifact = await f.store.registerArtifact(f.connection.endpointCredential, {
      ...f.registration,
      contentRef: `content:distinct-original-${index}`,
      requestId: `distinct-original-${index}`,
    });
    const version = artifact.versions[0];
    if (!version) throw new Error('Missing original version');
    const change = await f.post('/api/collaboration/projects/artifacts/change', f.owner.sessionToken, {
      ...f.coordinates,
      roadmapId: f.a.roadmapId,
      artifactId: artifact.artifactId,
      action: 'attach',
      requestId: `attach-distinct-${index}`,
      expectedRevision: 0,
      versionRef: f.versionRef(version),
    });
    expect(change.status).toBe(200);
  }
  const list = (page = {}) =>
    f.post('/api/collaboration/projects/artifacts/list', f.owner.sessionToken, {
      ...f.coordinates,
      roadmapId: f.a.roadmapId,
      ...page,
    });
  const first = await list();
  expect(first.value).toMatchObject({ total: 31, offset: 0, nextOffset: 30 });
  expect(first.value.items).toHaveLength(30);
  expect(first.value.items.every((item: { availability: string }) => item.availability === 'available')).toBe(true);
  const next = await list({ offset: first.value.nextOffset, expectedSnapshot: first.value.snapshot });
  expect(next.value.items).toHaveLength(1);
  const ids = [...first.value.items, ...next.value.items].map(
    (item: { reference: { artifactId: string } }) => item.reference.artifactId,
  );
  expect(new Set(ids).size).toBe(31);
  const reference = first.value.items[0].reference;
  await f.post('/api/collaboration/projects/artifacts/change', f.owner.sessionToken, {
    ...f.coordinates,
    roadmapId: f.a.roadmapId,
    artifactId: reference.artifactId,
    action: 'remove',
    requestId: 'remove-between-pages',
    expectedRevision: reference.revision,
  });
  expect((await list({ offset: 30, expectedSnapshot: first.value.snapshot })).status).toBe(409);
});

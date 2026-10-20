import { expect, it } from 'vitest';
import { readArtifactRequestReceipt } from '../artifact-history.js';
import { CollectiveArtifactStore } from '../artifact-store.js';
import { PersistentServiceState } from '../persistence.js';
import { artifactFixture } from './artifact.fixture.js';

async function catalogueWithVersions(total: number) {
  const f = await artifactFixture();
  const published = await f.store.registerArtifact(f.connection.endpointCredential, f.registration);
  const persistence = await PersistentServiceState.load(f.directory);
  await persistence.transaction((state) => {
    const artifact = state.artifacts[published.artifactId];
    if (!artifact) throw new Error('Missing canonical entry');
    const first = artifact.versions[0];
    if (!first) throw new Error('Missing original version');
    artifact.versions = Array.from({ length: total }, (_, i) => ({
      ...first,
      ownerRevision: i + 1,
      receiptRef: `receipt:${i + 1}`,
    }));
    artifact.revision = total;
  });
  const catalogue = new CollectiveArtifactStore(persistence, Date.now);
  return { ...f, persistence, catalogue, artifactId: published.artifactId };
}

it('a 10000-version work sends only its head and count in the repeatedly polled directory', async () => {
  const f = await catalogueWithVersions(10000);
  const artifacts = f.catalogue.list(f.member.sessionToken, f.coordinates);
  expect(artifacts[0]?.versions).toHaveLength(1);
  expect(artifacts[0]).toMatchObject({ versionCount: 10000, versions: [{ ownerRevision: 10000 }] });
  expect(Buffer.byteLength(JSON.stringify(artifacts))).toBeLessThan(2000);
});

it('pages an immutable history snapshot across a new head and checks fresh access on every page', async () => {
  const f = await catalogueWithVersions(61);
  const input = { ...f.coordinates, artifactId: f.artifactId, sourceEventId: f.source.eventId };
  const first = f.catalogue.history(f.member.sessionToken, input);
  expect(first.versions).toHaveLength(30);
  expect(first.versions[0]?.ownerRevision).toBe(61);
  expect(first.versions.at(-1)?.ownerRevision).toBe(32);
  await f.persistence.transaction((state) => {
    const artifact = state.artifacts[f.artifactId];
    const head = artifact?.versions.at(-1);
    if (!artifact || !head) throw new Error('Missing canonical head');
    artifact.versions.push({ ...head, ownerRevision: 62, receiptRef: 'receipt:62' });
  });
  const second = f.catalogue.history(f.member.sessionToken, {
    ...input,
    offset: first.nextOffset,
    snapshotOwnerRevision: first.snapshotOwnerRevision,
    expectedSnapshot: first.snapshot,
  });
  expect(second.total).toBe(61);
  expect(second.versions[0]?.ownerRevision).toBe(31);
  const last = f.catalogue.history(f.member.sessionToken, {
    ...input,
    offset: second.nextOffset,
    snapshotOwnerRevision: first.snapshotOwnerRevision,
    expectedSnapshot: first.snapshot,
  });
  expect(last.versions.map((version) => version.ownerRevision)).toEqual([1]);
  expect(last.nextOffset).toBeUndefined();
  expect(f.catalogue.history(f.member.sessionToken, input).versions[0]?.ownerRevision).toBe(62);
  expect(() =>
    f.catalogue.history(f.member.sessionToken, {
      ...input,
      offset: 30,
      snapshotOwnerRevision: 61,
      expectedSnapshot: `sha256:${'0'.repeat(64)}`,
    }),
  ).toThrow(expect.objectContaining({ statusCode: 409 }));
  await f.persistence.transaction((state) => {
    const artifact = state.artifacts[f.artifactId];
    if (!artifact) throw new Error('Missing canonical artifact');
    artifact.access[f.member.human.humanId] = { revision: 2, status: 'revoked', mayApply: false };
  });
  expect(() =>
    f.catalogue.history(f.member.sessionToken, {
      ...input,
      offset: 30,
      snapshotOwnerRevision: 61,
      expectedSnapshot: first.snapshot,
    }),
  ).toThrow(expect.objectContaining({ statusCode: 403 }));
});

it('looks up old adoption receipts in a bounded visible-request batch and hides them after resource revoke', async () => {
  const f = await catalogueWithVersions(61);
  await f.persistence.transaction((state) => {
    const artifact = state.artifacts[f.artifactId];
    if (!artifact) throw new Error('Missing canonical artifact');
    const version = artifact.versions[1];
    if (!version) throw new Error('Missing historical version');
    version.lineage = {
      requestId: 'request',
      proposalRef: 'proposal',
      requestEventId: f.source.eventId,
      sourceEventId: f.source.eventId,
      sourceOwnerRevision: 1,
      location: { channelId: 'general' },
    };
    version.adoptedByHumanId = f.owner.human.humanId;
  });
  const input = { ...f.coordinates, requestEventIds: [f.source.eventId] };
  const page = readArtifactRequestReceipt(f.persistence.snapshot(), f.member.sessionToken, input);
  expect(page.receipts).toHaveLength(1);
  expect(page.receipts[0]?.artifact.versions).toHaveLength(1);
  expect(page.receipts[0]?.version.ownerRevision).toBe(2);
  expect(() =>
    readArtifactRequestReceipt(f.persistence.snapshot(), f.member.sessionToken, {
      ...input,
      requestEventIds: Array(31).fill(f.source.eventId),
    }),
  ).toThrow();
  await f.persistence.transaction((state) => {
    const artifact = state.artifacts[f.artifactId];
    if (!artifact) throw new Error('Missing canonical artifact');
    artifact.access[f.member.human.humanId] = { revision: 2, status: 'revoked', mayApply: false };
  });
  expect(readArtifactRequestReceipt(f.persistence.snapshot(), f.member.sessionToken, input).receipts).toEqual([]);
});

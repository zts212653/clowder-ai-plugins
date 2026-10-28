import { afterEach } from 'vitest';
import { artifactFixture } from './artifact.fixture.js';

const ownerTimers = new Set<ReturnType<typeof setInterval>>();
afterEach(() => {
  for (const timer of ownerTimers) clearInterval(timer);
  ownerTimers.clear();
});

export async function projectArtifactFixture() {
  const current = await artifactFixture();
  const a = await current.store.createCollectiveProject(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'project-a',
    channelId: 'general',
    title: '插件框架',
    purpose: '准确引用原件',
  });
  const b = await current.store.createCollectiveProject(current.member.sessionToken, {
    ...current.coordinates,
    requestId: 'project-b',
    channelId: 'general',
    title: '新用户上手',
    purpose: '保留已选版本',
  });
  let artifact = await current.store.registerArtifact(current.connection.endpointCredential, current.registration);
  const publish = async (revision: number) => {
    artifact = await current.store.registerArtifact(current.connection.endpointCredential, {
      ...current.registration,
      ownerRevision: revision,
      blobDigest: `sha256:${String(revision).repeat(64)}`,
      receiptRef: `owner-receipt:v${revision}`,
      requestId: `version-${revision}`,
      expectedRevision: artifact.revision,
      expectedCustodyRevision: 1,
    });
    return artifact.versions[0]!;
  };
  const v2 = await publish(2),
    v3 = await publish(3);
  // This Service-level fixture speaks the real authenticated owner relay. Native byte-owner coverage is in Core's browser journey.
  const ownerTimer = setInterval(() => {
    for (const operation of current.store.pollArtifactOperations(current.connection.endpointCredential, {
      ...current.coordinates,
      connectionId: current.connection.connectionId,
    })) {
      current.store.respondArtifactOperation(current.connection.endpointCredential, {
        ...current.coordinates,
        connectionId: current.connection.connectionId,
        relayRef: operation.relayRef,
        status: 'ok',
        ownerDecisionRef: 'service-test-owner-history',
        value: {
          contentRef: current.store
            .listArtifacts(current.owner.sessionToken, current.coordinates)
            .find((artifact) => artifact.artifactId === operation.constraint.artifactId)?.contentRef,
          total: 1,
          versions: [{ ownerRevision: operation.constraint.ownerRevision, receiptRef: 'service-test-owner-receipt' }],
        },
      });
    }
  }, 5);
  ownerTimers.add(ownerTimer);
  const versionRef = (version: typeof v2) => ({
    ownerRevision: version.ownerRevision,
    blobDigest: version.blobDigest,
    receiptRef: version.receiptRef,
  });
  const list = (roadmapId: string, token = current.owner.sessionToken) =>
    current.post('/api/collaboration/projects/artifacts/list', token, { ...current.coordinates, roadmapId });
  const change = (roadmapId: string, token: string, input: Record<string, unknown>) =>
    current.post('/api/collaboration/projects/artifacts/change', token, {
      ...current.coordinates,
      roadmapId,
      artifactId: artifact.artifactId,
      ...input,
    });
  return { ...current, a, b, list, change, publish, versionRef, v2, v3, artifact };
}

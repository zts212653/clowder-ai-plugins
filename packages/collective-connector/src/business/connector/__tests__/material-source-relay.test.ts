import { afterEach, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture } from './communication-work-custody.fixture.js';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

it('carries explicit publication and fresh reads through the real Service/Connector transport without copying source content', async () => {
  const f = await fixture();
  close = f.close;
  const coordinates = { serviceInstanceId: f.connection.serviceInstanceId, collectiveId: f.connection.collectiveId };
  const project = await f.store.createCollectiveProject(f.owner.sessionToken, {
    ...coordinates,
    requestId: 'material-project',
    channelId: 'general',
    title: 'Original project',
    purpose: 'Source authority',
  });
  let allowed = true,
    reads = 0;
  f.connector.setMaterialSource({
    async execute(operation, authority) {
      expect((await authority.reauthorize()).sourceEventId).toBe(operation.publication.sourceEventId);
      reads += 1;
      if (!allowed) return { status: 'unavailable', reason: 'access_revoked' };
      return {
        status: 'available',
        sourceKey: 'issue:org/repo#4',
        sourceRef: 'https://github.com/org/repo/issues/4',
        witness: { digest: 'a'.repeat(64), readAt: new Date().toISOString() },
        material: {
          kind: 'issue',
          title: 'Current source title',
          clauses: [{ clauseId: 'subject', text: 'Source body' }],
        },
      };
    },
  });
  async function through<T>(run: () => Promise<T>): Promise<T> {
    let complete = false;
    const pending = run().finally(() => {
      complete = true;
    });
    while (!complete) {
      await delay(10);
      await f.connector.sync(f.connection.connectionId);
    }
    return pending;
  }
  await through(() =>
    f.store.publishCollectiveMaterial(f.owner.sessionToken, {
      ...coordinates,
      requestId: 'publish-real-transport',
      roadmapId: project.roadmapId,
      connectionId: f.connection.connectionId,
      provider: 'github',
      sourceId: 'issue:org/repo#4',
    }),
  );
  const list = () =>
    f.store.listCollectiveMaterials(f.owner.sessionToken, { ...coordinates, roadmapId: project.roadmapId });
  expect((await through(list)).items[0]?.material.title).toBe('Current source title');
  allowed = false;
  const unavailable = await through(list);
  expect(unavailable.items).toEqual([]);
  expect(unavailable.pendingCount).toBe(0);
  expect(reads).toBe(3);
});

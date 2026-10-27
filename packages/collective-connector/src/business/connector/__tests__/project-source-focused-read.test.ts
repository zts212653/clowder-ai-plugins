import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { CollectiveServiceClient } from '../service-client.js';
import { fixture } from './communication-work-custody.fixture.js';

test('reading and suggesting one published material never rereads an unrelated source', async () => {
  const f = await fixture();
  try {
    const coordinates = {serviceInstanceId: f.connection.serviceInstanceId, collectiveId: f.connection.collectiveId};
    const project = await f.store.createCollectiveProject(f.owner.sessionToken, {
      ...coordinates, requestId: 'focused-project', channelId: 'general', title: 'Sources', purpose: 'Read one source',
    });
    const reads: string[] = [];
    f.connector.setMaterialSource({
      async execute(operation, authority) {
        await authority.reauthorize(); reads.push(operation.publication.sourceId);
        return {status: 'available', sourceKey: operation.publication.sourceId,
          sourceRef: 'https://github.com/org/repo/issues/' + operation.publication.sourceId.split('#')[1],
          witness: {digest: 'a'.repeat(64), readAt: new Date().toISOString()},
          material: {kind: 'issue', title: 'Original', clauses: [{clauseId: 'subject', text: 'Original passage'}]}};
      },
    });
    async function through<T>(run: () => Promise<T>) {
      let settled = false;
      const pending = run().finally(() => {settled = true;});
      while (!settled) {await delay(5); await f.connector.sync(f.connection.connectionId);}
      return pending;
    }
    for (const sourceId of ['issue:org/repo#4', 'issue:org/repo#5']) {
      await through(() => f.store.publishCollectiveMaterial(f.owner.sessionToken, {
        ...coordinates, requestId: 'share-' + sourceId, roadmapId: project.roadmapId,
        connectionId: f.connection.connectionId, provider: 'github', sourceId,
      }));
    }
    const listed = await through(() => f.connector.readProjectSource(f.source));
    const selected = listed.materials.find(row => row.sourceRef.endsWith('/4'))!;
    reads.length = 0;
    const actual = await through(() => f.connector.readProjectSource(f.source, selected.materialId));
    expect(actual.materials[0]?.material?.clauses[0]?.text).toBe('Original passage');
    const suggestion = await through(() => f.connector.suggestMaterial(f.source, {
      materialId: selected.materialId, expectedRevision: selected.revision,
      requestId: 'select-focused-source', clauseIds: ['subject'],
    }, f.agent));
    expect(suggestion.selections?.[0]?.actor).toMatchObject({kind: 'agent', catId: f.agent.catId});
    expect(reads).toEqual(['issue:org/repo#4', 'issue:org/repo#4']);
    reads.length = 0;
    const absent = await through(() => f.connector.readProjectSource(f.source, 'material_unpublished'));
    expect(absent.materials).toEqual([]);
    expect(reads).toEqual([]);
  } finally {await f.close();}
});

test('a source-backed mutation can return its committed receipt beyond the ordinary wire timeout', async () => {
  const at = '2026-10-27T09:10:00.000Z';
  const witness = {digest: 'a'.repeat(64), readAt: at};
  const material = {serviceInstanceId: 'svc_00000001', collectiveId: 'col_00000001',
    materialId: 'material_00000001', roadmapId: 'roadmap_00000001', sourceKey: 'issue:org/repo#4',
    publicationIds: ['materialpub_00000001'], revision: 2, firstWitness: witness, currentWitness: witness,
    witnesses: [witness], decisions: {}, createdAt: at, updatedAt: at};
  let commits = 0;
  const client = new CollectiveServiceClient(async (_url, init) => {
    if (init?.method === 'POST') commits++;
    // Scaled controlled owner latency. The effect happens before the old wire
    // deadline; aborting that deadline must not be mistaken for rollback.
    await delay(40, undefined, init?.signal ? {signal: init.signal} : {});
    return new Response(JSON.stringify(material), {status: 200, headers: {'content-type': 'application/json'}});
  }, 10);
  const receipt = await client.suggestMaterial('https://service.fixture', 'fixture-endpoint', {
    serviceInstanceId: material.serviceInstanceId, collectiveId: material.collectiveId,
    connectionId: 'con_00000001', catId: 'fixture-cat', participationRevision: 1,
    sourceEventId: 'evt_00000001', materialId: material.materialId,
    requestId: 'source-receipt', expectedRevision: 1, clauseIds: ['subject'],
  });
  expect(receipt).toEqual(material);
  expect(commits).toBe(1);
  await expect(client.readMetadata('https://service.fixture')).rejects.toMatchObject({
    code: 'ABORT_ERR',
  });
  expect(commits).toBe(1);
});

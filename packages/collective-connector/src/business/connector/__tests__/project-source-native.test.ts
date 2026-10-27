import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { openCollectiveContextReferences } from '../../../collective-context-refs.js';
import { createCollectivePublicNativeActions } from '../../../collective-public-native-context.js';
import { collectiveMaterialRecordSchema } from '../../contracts/types/collective-material.js';
import { collectiveProjectSourceReadSchema } from '../../contracts/types/collective-project-source.js';
import { publicSourceFixture } from './public-source-caller.fixture.js';

it('binds live Project material and date suggestions to actual native context across the owner relay', async () => {
  const f = await publicSourceFixture({ invocationId: 'fixture-running-turn' });
  try {
    const refs = await openCollectiveContextReferences(join(f.root, 'project-native-refs'), () => {});
    const actions = createCollectivePublicNativeActions({
      connector: f.connector,
      sourceCaller: f.sourceCaller,
      references: refs,
    });
    await f.admit();
    const invoke = (method: string, input: unknown) => Promise.resolve(actions[method]!(input, f.action));
    const { contextRef } = z
      .object({ contextRef: z.string() })
      .passthrough()
      .parse(await invoke('collective.context.current', {}));
    const coordinates = { serviceInstanceId: f.connection.serviceInstanceId, collectiveId: f.connection.collectiveId };
    const project = await f.store.createCollectiveProject(f.serviceOwner.sessionToken, {
      ...coordinates,
      requestId: 'native-project',
      channelId: 'general',
      title: 'Native Project',
      purpose: 'Original source',
    });
    let available = true;
    f.connector.setMaterialSource({
      async execute(_operation, authority) {
        await authority.reauthorize();
        if (!available) return { status: 'unavailable', reason: 'deleted' };
        return {
          status: 'available',
          sourceKey: 'issue:org/repo#4',
          sourceRef: 'https://github.com/org/repo/issues/4',
          witness: { digest: 'b'.repeat(64), readAt: new Date().toISOString() },
          material: {
            kind: 'issue',
            title: 'Published source',
            clauses: [{ clauseId: 'subject', text: 'Actual source passage' }],
          },
        };
      },
    });
    async function through<T>(run: () => Promise<T>): Promise<T> {
      let complete = false;
      const result = run()
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
        .finally(() => {
          complete = true;
        });
      while (!complete) {
        await delay(10);
        await f.connector.sync(f.connection.connectionId);
      }
      const settled = await result;
      if ('error' in settled) throw settled.error;
      return settled.value;
    }
    await through(() =>
      f.store.publishCollectiveMaterial(f.serviceOwner.sessionToken, {
        ...coordinates,
        requestId: 'native-share',
        roadmapId: project.roadmapId,
        connectionId: f.connection.connectionId,
        provider: 'github',
        sourceId: 'issue:org/repo#4',
      }),
    );
    const context = collectiveProjectSourceReadSchema.parse(
      await through(() => invoke('collective.project.context', { contextRef })),
    );
    expect(context.materials[0]?.title).toBe('Published source');
    expect(JSON.stringify(context)).not.toContain('Actual source passage');
    const task = await f.store.createCollectiveProjectTask(f.serviceOwner.sessionToken, {
      ...coordinates,
      requestId: 'native-date-task',
      roadmapId: project.roadmapId,
      expectedRoadmapRevision: project.revision,
      channelId: 'general',
      title: 'Public task',
      intendedOutcome: 'Only suggest its promise',
      accountability: 'self',
    });
    await invoke('collective.work.suggest-time', {
      contextRef,
      workId: task.work.workId,
      expectedRevision: task.work.revision,
      requestId: 'native-date-suggestion',
      field: 'businessDeadline',
      time: { value: '2026-11-04T20:00:00Z', timeZone: 'America/Los_Angeles' },
      reason: 'Awaiting accountable Human confirmation',
    });
    const suggested = f.store.listCollectiveCollaboration(f.serviceOwner.sessionToken, coordinates.collectiveId)
      .works[0]!;
    expect(suggested.time?.businessDeadline).toBeUndefined();
    expect(suggested.timeSuggestions?.[0]?.actor).toMatchObject({ kind: 'agent', catId: f.action.catId });
    const materialId = context.materials[0]!.materialId;
    const original = collectiveProjectSourceReadSchema.parse(
      await through(() => invoke('collective.material.read', { contextRef, materialId })),
    );
    expect(original.materials[0]?.material?.clauses[0]?.text).toBe('Actual source passage');
    const selection = collectiveMaterialRecordSchema.parse(
      await through(() =>
        invoke('collective.material.suggest', {
          contextRef,
          materialId,
          expectedRevision: original.materials[0]!.revision,
          requestId: 'native-selection',
          clauseIds: ['subject'],
        }),
      ),
    );
    expect(selection.selections?.[0]?.actor).toMatchObject({ kind: 'agent', catId: f.action.catId });
    await expect(invoke('collective.material.read', { contextRef: 'wrong', materialId })).rejects.toMatchObject({
      code: 'RETURN_REF_INVALID',
    });
    await expect(
      invoke('collective.material.suggest', {
        contextRef,
        materialId,
        expectedRevision: selection.revision,
        requestId: 'forged-actor',
        clauseIds: ['subject'],
        catId: 'forged',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_COLLECTIVE_REQUEST' });
    available = false;
    const denied = collectiveProjectSourceReadSchema.parse(
      await through(() => invoke('collective.material.read', { contextRef, materialId })),
    );
    expect(denied.materials).toEqual([]);
    expect(JSON.stringify(denied)).not.toContain('Actual source passage');
    expect(
      f.store.listCollectiveCollaboration(f.serviceOwner.sessionToken, coordinates.collectiveId).works,
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type {
  CollectiveMaterialSourcePort,
  CollectiveMaterialSourceResult,
} from '../../contracts/types/collective-material.js';
import { SERVICE_STATE_FILE } from '../persistence.js';
import { CollectiveServiceStore } from '../store.js';
import { participationFixture } from './participation-fixture.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'project-material-'));
  directories.push(directory);
  let current: CollectiveMaterialSourceResult = {
    status: 'available',
    sourceKey: 'feishu:minute:meeting-1',
    sourceRef: 'feishu://meeting-artifacts/minute/meeting-1?revision=generation-1',
    witness: { digest: 'a'.repeat(64), readAt: '2026-10-27T01:00:00.000Z', generationScope: 'generation-1' },
    material: {
      kind: 'meeting',
      title: 'Private source title',
      author: 'Owner',
      occurredAt: '2026-10-26T21:00:00.000Z',
      clauses: [
        { clauseId: 'clause-first', text: 'Connect the plugin by Friday' },
        { clauseId: 'clause-second', text: 'Keep the original source authority' },
      ],
    },
  };
  const publications: string[] = [];
  const source: CollectiveMaterialSourcePort = {
    async execute(operation, authority) {
      await authority.reauthorize();
      if (operation.action === 'publish') publications.push(operation.publication.publicationId);
      return structuredClone(current);
    },
  };
  const f = await participationFixture(directory, { materialSource: source });
  const project = await f.store.createCollectiveProject(f.owner.sessionToken, {
    ...f.coordinates,
    requestId: 'project',
    channelId: 'general',
    title: 'Plugin',
    purpose: 'Keep the original Work',
  });
  const input = {
    ...f.coordinates,
    requestId: 'publish',
    roadmapId: project.roadmapId,
    connectionId: f.connection.connectionId,
    provider: 'feishu',
    sourceId: 'c'.repeat(64),
  };
  return {
    ...f,
    directory,
    source,
    project,
    input,
    publications,
    setCurrent(value: CollectiveMaterialSourceResult) {
      current = value;
    },
    get current() {
      return current;
    },
  };
}

it('deduplicates published material, sorts one clause once and preserves Work through source revision and restart', async () => {
  const f = await fixture();
  const first = await f.store.publishCollectiveMaterial(f.owner.sessionToken, f.input);
  const duplicate = await f.store.publishCollectiveMaterial(f.owner.sessionToken, {
    ...f.input,
    requestId: 'another-arrival',
  });
  expect(duplicate.materialId).toBe(first.materialId);
  const list = await f.store.listCollectiveMaterials(f.owner.sessionToken, {
    ...f.coordinates,
    roadmapId: f.project.roadmapId,
  });
  expect(list.items).toHaveLength(1);
  expect(list.pendingCount).toBe(1);
  const item = list.items[0]!;
  const command = {
    ...f.coordinates,
    requestId: 'create',
    materialId: item.materialId,
    expectedRevision: item.revision,
    clauseId: 'clause-first',
    action: 'create',
    expectedRoadmapRevision: f.project.revision,
    title: 'Connect the plugin',
    intendedOutcome: 'Owner confirmed this scope',
  };
  const results = await Promise.all([
    f.store.sortCollectiveMaterial(f.owner.sessionToken, command),
    f.store.sortCollectiveMaterial(f.owner.sessionToken, { ...command, requestId: 'racing-create' }),
  ]);
  expect(new Set(results.map((result) => result.decision.workId)).size).toBe(1);
  const work = f.store.listCollectiveCollaboration(f.owner.sessionToken, f.coordinates.collectiveId).works[0]!;
  expect(work.accountableHumanId).toBeUndefined();
  expect(work.assignment).toBeUndefined();
  expect(work.time).toBeUndefined();
  expect(work.materialLinks).toHaveLength(1);
  expect(
    (await f.store.listCollectiveMaterials(f.owner.sessionToken, { ...f.coordinates, roadmapId: f.project.roadmapId }))
      .pendingCount,
  ).toBe(1);
  if (f.current.status !== 'available') throw new Error('fixture');
  f.setCurrent({
    ...f.current,
    witness: { ...f.current.witness, digest: 'b'.repeat(64), readAt: '2026-10-27T02:00:00.000Z' },
    material: { ...f.current.material, title: 'Revised private source title' },
  });
  const revised = await f.store.listCollectiveMaterials(f.owner.sessionToken, {
    ...f.coordinates,
    roadmapId: f.project.roadmapId,
  });
  expect(revised.items[0]?.currentness).toBe('revised');
  expect(f.store.listCollectiveCollaboration(f.owner.sessionToken, f.coordinates.collectiveId).works[0]).toEqual(work);
  const reopened = await CollectiveServiceStore.open({
    dataDirectory: f.directory,
    humanAuthProvider: f.humanAuthProvider,
    materialSource: f.source,
  });
  const recovered = await reopened.store.listCollectiveMaterials(f.owner.sessionToken, {
    ...f.coordinates,
    roadmapId: f.project.roadmapId,
  });
  expect(recovered.items[0]?.decisions['clause-first']?.workId).toBe(work.workId);
  const bytes = await readFile(join(f.directory, SERVICE_STATE_FILE), 'utf8');
  expect(bytes).not.toContain('Private source title');
  expect(bytes).not.toContain('Revised private source title');
  expect(bytes).not.toContain('Connect the plugin by Friday');
});

it('rechecks source authority before exposing metadata or sorting and never counts an unpublished source', async () => {
  const f = await fixture();
  expect(
    (await f.store.listCollectiveMaterials(f.owner.sessionToken, { ...f.coordinates, roadmapId: f.project.roadmapId }))
      .items,
  ).toEqual([]);
  const published = await f.store.publishCollectiveMaterial(f.owner.sessionToken, f.input);
  f.setCurrent({ status: 'unavailable', reason: 'access_revoked' });
  const unavailable = await f.store.listCollectiveMaterials(f.owner.sessionToken, {
    ...f.coordinates,
    roadmapId: f.project.roadmapId,
  });
  expect(unavailable.items).toEqual([]);
  expect(unavailable.pendingCount).toBe(0);
  expect(JSON.stringify(unavailable)).not.toContain('Private source title');
  await expect(
    f.store.sortCollectiveMaterial(f.owner.sessionToken, {
      ...f.coordinates,
      requestId: 'revoked-create',
      materialId: published.materialId,
      expectedRevision: published.revision,
      clauseId: 'clause-first',
      action: 'create',
      expectedRoadmapRevision: f.project.revision,
      title: 'No authority',
      intendedOutcome: 'No',
    }),
  ).rejects.toMatchObject({ code: 'MATERIAL_SOURCE_UNAVAILABLE' });
  expect(f.store.listCollectiveCollaboration(f.owner.sessionToken, f.coordinates.collectiveId).works).toHaveLength(0);
  await f.store.sortCollectiveMaterial(f.owner.sessionToken, {
    ...f.coordinates,
    requestId: 'remove-unavailable',
    materialId: published.materialId,
    expectedRevision: published.revision,
    action: 'ignore',
  });
  expect(
    (await f.store.listCollectiveMaterials(f.owner.sessionToken, { ...f.coordinates, roadmapId: f.project.roadmapId }))
      .unavailable,
  ).toEqual([]);
});

it('projects one material attention row per project and reads deadline attention without creating a Host Task', async () => {
  const f = await fixture();
  await f.store.publishCollectiveMaterial(f.owner.sessionToken, f.input);
  await f.store.publishCollectiveMaterial(f.owner.sessionToken, { ...f.input, requestId: 'duplicate-attention' });
  const created = await f.store.createCollectiveProjectTask(f.owner.sessionToken, {
    ...f.coordinates,
    requestId: 'owned-work',
    roadmapId: f.project.roadmapId,
    expectedRoadmapRevision: f.project.revision,
    channelId: 'general',
    title: 'Original task',
    intendedOutcome: 'Original scope',
    accountability: 'self',
  });
  await f.store.changeCollectiveWorkTime(f.owner.sessionToken, {
    ...f.coordinates,
    requestId: 'overdue-date',
    workId: created.work.workId,
    expectedRevision: created.work.revision,
    action: 'set',
    field: 'businessDeadline',
    time: { value: '2020-01-01T12:00:00.000Z', timeZone: 'UTC' },
  });
  const read = () =>
    f.store.readCollectiveProjectAttention(f.connection.endpointCredential, {
      ...f.coordinates,
      connectionId: f.connection.connectionId,
    });
  const current = await read();
  expect(current.items.filter((item) => item.kind === 'triage')).toHaveLength(1);
  expect(current.items.find((item) => item.kind === 'triage')?.count).toBe(1);
  expect(current.items.find((item) => item.kind === 'overdue')?.workId).toBe(created.work.workId);
  f.setCurrent({ status: 'unavailable', reason: 'access_revoked' });
  expect((await read()).items.some((item) => item.kind === 'triage')).toBe(false);
  expect(f.store.listCollectiveCollaboration(f.owner.sessionToken, f.coordinates.collectiveId).works).toHaveLength(1);
});

it('lets a current Channel Cat read and select only live published clauses without deciding their destination', async () => {
  const f = await fixture();
  const declaration = await f.store.publishParticipation(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    revision: 1,
    agents: [{ catId: 'reader-cat', displayName: 'Reader', channelIds: ['general'] }],
  });
  const request = await f.store.postHumanMessage(f.owner.sessionToken, {
    ...f.coordinates,
    clientEventId: 'reader-request',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: 'Read the published project material',
  });
  const scope = {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    sourceEventId: request.eventId,
    catId: 'reader-cat',
    participationRevision: declaration.revision,
  };
  expect((await f.store.readCollectiveProjectSource(f.connection.endpointCredential, scope)).materials).toEqual([]);
  const published = await f.store.publishCollectiveMaterial(f.owner.sessionToken, f.input);
  const context = await f.store.readCollectiveProjectSource(f.connection.endpointCredential, scope);
  expect(context.materials).toHaveLength(1);
  expect(JSON.stringify(context)).not.toContain('Connect the plugin by Friday');
  const read = await f.store.readCollectiveProjectSource(f.connection.endpointCredential, {
    ...scope,
    materialId: published.materialId,
  });
  expect(read.materials[0]?.material?.clauses[0]?.text).toBe('Connect the plugin by Friday');
  const selected = await f.store.suggestCollectiveMaterial(f.connection.endpointCredential, {
    ...scope,
    materialId: published.materialId,
    expectedRevision: context.materials[0]!.revision,
    requestId: 'select-clause',
    clauseIds: ['clause-first'],
  });
  expect(selected.selections?.[0]?.actor).toMatchObject({ kind: 'agent', catId: 'reader-cat' });
  expect(f.store.listCollectiveCollaboration(f.owner.sessionToken, f.coordinates.collectiveId).works).toHaveLength(0);
  const selectedRead = await f.store.readCollectiveProjectSource(f.connection.endpointCredential, {
    ...scope,
    materialId: published.materialId,
  });
  expect(selectedRead.materials[0]?.material?.clauses[0]?.suggestedBy?.kind).toBe('agent');
  f.setCurrent({ status: 'unavailable', reason: 'deleted' });
  const denied = await f.store.readCollectiveProjectSource(f.connection.endpointCredential, {
    ...scope,
    materialId: published.materialId,
  });
  expect(denied.materials).toEqual([]);
  expect(JSON.stringify(denied)).not.toContain('Private source title');
  await expect(
    f.store.suggestCollectiveMaterial(f.connection.endpointCredential, {
      ...scope,
      materialId: published.materialId,
      expectedRevision: selected.revision,
      requestId: 'select-deleted',
      clauseIds: ['clause-second'],
    }),
  ).rejects.toMatchObject({ code: 'MATERIAL_SOURCE_UNAVAILABLE' });
  await f.store.publishParticipation(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    revision: declaration.revision + 1,
    agents: [],
  });
  await expect(f.store.readCollectiveProjectSource(f.connection.endpointCredential, scope)).rejects.toThrow();
});

it('refuses another Human sorting the Project while its owner confirms one original destination', async () => {
  const f = await fixture();
  const invite = await f.store.createInvite({
    sessionToken: f.owner.sessionToken,
    collectiveId: f.coordinates.collectiveId,
  });
  const attempt = await f.store.beginHumanAuth({
    provider: 'github',
    intent: { kind: 'accept_invite', inviteToken: invite.inviteToken },
  });
  const completion = await f.store.completeHumanAuth({
    provider: 'github',
    state: attempt.state,
    code: 'second-reader',
  });
  const member = await f.store.exchangeHumanAuthCompletion(completion.completionToken);
  const item = await f.store.publishCollectiveMaterial(f.owner.sessionToken, f.input);
  const command = {
    ...f.coordinates,
    materialId: item.materialId,
    expectedRevision: item.revision,
    requestId: 'owner-destination',
    action: 'reference',
  };
  const results = await Promise.allSettled([
    f.store.sortCollectiveMaterial(f.owner.sessionToken, command),
    f.store.sortCollectiveMaterial(member.sessionToken, { ...command, requestId: 'member-destination' }),
  ]);
  expect(results[0]?.status).toBe('fulfilled');
  expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'ROADMAP_AUTHORITY_REQUIRED' } });
  expect(f.store.listCollectiveCollaboration(f.owner.sessionToken, f.coordinates.collectiveId).works).toHaveLength(0);
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CollectiveServiceStore } from '../store.js';
import { participationFixture } from './participation-fixture.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'collective-time-'));
  directories.push(directory);
  const current = await participationFixture(directory);
  const source = await current.store.postHumanMessage(current.owner.sessionToken, {
    ...current.coordinates,
    clientEventId: 'time-source',
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body: 'Finish the integration; the meeting mentioned Friday.',
  });
  const proposal = await current.store.proposeCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'time-proposal',
    sourceEventId: source.eventId,
  });
  const work = await current.store.commitCollectiveWork(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'time-commit',
    workId: proposal.workId,
    expectedRevision: proposal.revision,
  });
  const roadmap = await current.store.createCollectiveRoadmap(current.owner.sessionToken, {
    ...current.coordinates,
    requestId: 'time-roadmap',
    sourceEventId: source.eventId,
    title: 'Integration',
    purpose: 'One project and its original work',
    workIds: [work.workId],
  });
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
    code: 'member',
  });
  const member = await current.store.exchangeHumanAuthCompletion(completion.completionToken);
  return { ...current, directory, source, work, roadmap, member };
}

const deadline = { value: '2026-10-30T23:59:59+08:00', timeZone: 'Asia/Shanghai' };

it('keeps owner-confirmed dates, estimates and the project target separate through retry and restart', async () => {
  const f = await fixture();
  const input = {
    ...f.coordinates,
    requestId: 'set-deadline',
    workId: f.work.workId,
    expectedRevision: f.work.revision,
    action: 'set',
    field: 'businessDeadline',
    time: deadline,
  };
  const changed = await f.store.changeCollectiveWorkTime(f.owner.sessionToken, input);
  expect(changed.time?.businessDeadline).toMatchObject({
    ...deadline,
    actor: { kind: 'human', humanId: f.owner.human.humanId },
    sourceRef: expect.any(String),
  });
  expect(changed.time?.estimatedCompletion).toBeUndefined();
  expect(changed.history.at(-1)).toMatchObject({
    action: 'time_changed',
    timeChange: {
      field: 'businessDeadline',
      previous: null,
      current: { value: deadline.value },
    },
  });
  expect(await f.store.changeCollectiveWorkTime(f.owner.sessionToken, input)).toEqual(changed);
  const later = { value: '2026-11-04T17:00:00-08:00', timeZone: 'America/Los_Angeles' };
  const estimated = await f.store.changeCollectiveWorkTime(f.owner.sessionToken, {
    ...input,
    requestId: 'estimate',
    expectedRevision: changed.revision,
    field: 'estimatedCompletion',
    time: later,
  });
  expect(estimated.time?.businessDeadline?.value).toBe(deadline.value);
  expect(estimated.time?.estimatedCompletion?.value).toBe(later.value);
  const targeted = await f.store.setCollectiveRoadmapTargetDate(f.owner.sessionToken, {
    ...f.coordinates,
    requestId: 'target',
    roadmapId: f.roadmap.roadmapId,
    expectedRevision: f.roadmap.revision,
    time: later,
  });
  expect(targeted.targetDate?.value).toBe(later.value);
  const reopened = await CollectiveServiceStore.open({
    dataDirectory: f.directory,
    humanAuthProvider: f.humanAuthProvider,
  });
  const projection = reopened.store.listCollectiveCollaboration(f.owner.sessionToken, f.coordinates.collectiveId);
  expect(projection.works.find((item) => item.workId === f.work.workId)).toEqual(estimated);
  expect(projection.roadmaps.find((item) => item.roadmapId === f.roadmap.roadmapId)).toEqual(targeted);
});

it('requires the accountable Human to set promises and resolve suggestions with a current revision', async () => {
  const f = await fixture();
  const input = {
    ...f.coordinates,
    requestId: 'unauthorized',
    workId: f.work.workId,
    expectedRevision: f.work.revision,
    action: 'set',
    field: 'businessDeadline',
    time: deadline,
  };
  await expect(f.store.changeCollectiveWorkTime(f.member.sessionToken, input)).rejects.toMatchObject({
    code: 'WORK_AUTHORITY_REQUIRED',
  });
  const suggested = await f.store.changeCollectiveWorkTime(f.member.sessionToken, {
    ...input,
    requestId: 'suggest',
    action: 'suggest',
    reason: 'The prerequisite is still waiting.',
    sourceEventId: f.source.eventId,
  });
  expect(suggested.time?.businessDeadline).toBeUndefined();
  const suggestion = suggested.timeSuggestions?.at(-1)!;
  expect(suggestion).toMatchObject({ status: 'pending', actor: { humanId: f.member.human.humanId } });
  const response = {
    ...f.coordinates,
    requestId: 'accept',
    workId: f.work.workId,
    expectedRevision: suggested.revision,
    action: 'respond',
    suggestionId: suggestion.suggestionId,
    decision: 'accept',
  };
  await expect(f.store.changeCollectiveWorkTime(f.member.sessionToken, response)).rejects.toMatchObject({
    code: 'WORK_AUTHORITY_REQUIRED',
  });
  const accepted = await f.store.changeCollectiveWorkTime(f.owner.sessionToken, response);
  expect(accepted.time?.businessDeadline).toMatchObject({
    ...deadline,
    actor: { humanId: f.owner.human.humanId },
    suggestedBy: { humanId: f.member.human.humanId },
  });
  expect(accepted.timeSuggestions?.at(-1)?.status).toBe('accepted');
  await expect(
    f.store.changeCollectiveWorkTime(f.owner.sessionToken, { ...input, requestId: 'stale-owner' }),
  ).rejects.toMatchObject({ code: 'WORK_REVISION_CONFLICT' });
});

it('serializes concurrent date changes and preserves the previous value when a deadline is cleared', async () => {
  const f = await fixture();
  const input = {
    ...f.coordinates,
    requestId: 'concurrent-a',
    workId: f.work.workId,
    expectedRevision: f.work.revision,
    action: 'set',
    field: 'businessDeadline',
    time: deadline,
  };
  const results = await Promise.allSettled([
    f.store.changeCollectiveWorkTime(f.owner.sessionToken, input),
    f.store.changeCollectiveWorkTime(f.owner.sessionToken, { ...input, requestId: 'concurrent-b' }),
  ]);
  expect(results.map((item) => item.status).sort()).toEqual(['fulfilled', 'rejected']);
  const current = f.store.listCollectiveCollaboration(f.owner.sessionToken, f.coordinates.collectiveId).works[0];
  const cleared = await f.store.changeCollectiveWorkTime(f.owner.sessionToken, {
    ...input,
    requestId: 'clear',
    expectedRevision: current.revision,
    time: null,
  });
  expect(cleared.time?.businessDeadline).toBeUndefined();
  expect(cleared.history.at(-1)?.timeChange).toMatchObject({
    field: 'businessDeadline',
    previous: { value: deadline.value },
    current: null,
  });
  await expect(
    f.store.changeCollectiveWorkTime(f.owner.sessionToken, {
      ...input,
      requestId: 'forged-start',
      expectedRevision: cleared.revision,
      field: 'actualStart',
    }),
  ).rejects.toThrow();
});

it('lets another current Channel Cat suggest a date from its exact source without acquiring execution or promise authority', async () => {
  const f = await fixture();
  await f.store.publishParticipation(f.connection.endpointCredential, {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    revision: 1,
    agents: [{ catId: 'reader-cat', displayName: 'Reader', channelIds: ['general'] }],
  });
  const input = {
    ...f.coordinates,
    connectionId: f.connection.connectionId,
    catId: 'reader-cat',
    participationRevision: 1,
    workId: f.work.workId,
    expectedRevision: f.work.revision,
    requestId: 'cat-date',
    action: 'suggest',
    field: 'businessDeadline',
    time: deadline,
    reason: 'A date suggestion, not a promise',
    sourceEventId: f.source.eventId,
  };
  const result = await f.store.changeCollectiveAgentWorkTime(f.connection.endpointCredential, input);
  expect(result.time?.businessDeadline).toBeUndefined();
  expect(result.timeSuggestions?.at(-1)).toMatchObject({
    actor: { kind: 'agent', catId: 'reader-cat' },
    sourceEventId: f.source.eventId,
    status: 'pending',
  });
  await expect(
    f.store.changeCollectiveAgentWorkTime(f.connection.endpointCredential, {
      ...input,
      requestId: 'cat-promise',
      expectedRevision: result.revision,
      action: 'set',
      reason: undefined,
    }),
  ).rejects.toThrow();
  await expect(
    f.store.changeCollectiveAgentWorkTime(f.connection.endpointCredential, {
      ...input,
      requestId: 'cat-source-forgery',
      expectedRevision: result.revision,
      sourceEventId: 'not-published',
    }),
  ).rejects.toThrow();
});

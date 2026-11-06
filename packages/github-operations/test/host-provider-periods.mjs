import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { installedTrackingHost } from './installed-tracking-host.mjs';
import { artifactImports } from './installed-tracking-history.mjs';

const hostRoot = await realpath(process.env.CLOWDER_GITHUB_TERMINAL_HOST_ROOT ?? 'missing-explicit-host-root');
const artifact = await realpath(process.env.CLOWDER_GITHUB_TERMINAL_ARTIFACT_ROOT ?? 'missing-explicit-installed-artifact');
const { ownedRedisFixture } = await import(pathToFileURL(join(hostRoot, 'packages/api/test/helpers/owned-redis-fixture.js')).href);
const redisFixture = ownedRedisFixture('github-provider-period-installed'), load = artifactImports(artifact);
const head = 'b'.repeat(40), at = Date.parse('2026-11-01T00:00:00Z'), subjectKey = 'pr:example/project#12';
function snapshot(state) {
  return { state, headSha: head, ci: 'pass', commentsComplete: true, comments: [], reviews: [], terminalFacts: {
    schemaVersion: 1, subjectKey, state, headSha: head, closedAt: new Date(at).toISOString(),
    mergedAt: state === 'merged' ? new Date(at).toISOString() : null, mergeCommitSha: state === 'merged' ? 'c'.repeat(40) : null,
    source: 'github-api', observedAt: at + 1, reviews: [], ci: { headSha: head, status: 'pass',
      source: 'github-status-check-rollup', observedAt: at + 1, checkRollup: 'present',
      checks: [{ name: 'gate', bucket: 'pass', providerStatus: 'COMPLETED', providerConclusion: 'SUCCESS' }] } } };
}
function nativeHistory(review) {
  const { currentHeadSha, currentHeadObservedAt, headGeneration, ci, cloud, ...history } = review;
  return history;
}

for (const state of ['merged', 'closed']) test(`installed Host keeps historical ${state} repair factual and reserves cascade for a genuine new period`, async t => {
  const f = await installedTrackingHost(t, { hostRoot, artifact, redisFixture, providerSnapshot: snapshot(state) });
  const { SdkCommunityEventLog } = await load('business/domains/community/CommunityEventLog.js');
  const { SdkCommunityObjectStore } = await load('business/domains/community/CommunityObjectStore.js');
  const { SdkCommunityRepoConfigStore } = await load('business/domains/community/CommunityRepoConfigStore.js');
  const { CommunityProjector } = await load('business/domains/community/community-projector.js');
  const { GitHubWaitStorage } = await load('typed-wait-storage.js');
  const journal = new SdkCommunityEventLog(f.facade), objects = new SdkCommunityObjectStore(f.facade), projector = new CommunityProjector(journal, objects);
  const issue = 'issue:example/project#99';
  await new SdkCommunityRepoConfigStore(f.facade).upsert({ repo: 'example/project', guardThreadId: f.thread.id,
    guardCatId: 'codex61-sol', reviewMode: 'maintainer_review' });
  const seeds = [
    [issue, 'case.bootstrap', { mappedState: 'in_progress' }],
    [subjectKey, 'pr.opened', { body: 'Fixes #99' }],
    [subjectKey, 'case.external_review_assigned', { mode: 'maintainer_review', cloudPolicy: 'optional', reviewerCatId: 'original-reviewer', reviewerThreadId: 'original-thread' }],
    [subjectKey, 'case.head_observed', { headSha: 'a'.repeat(40) }],
    [subjectKey, 'case.ci_observed', { headSha: 'a'.repeat(40), status: 'pending' }],
    [subjectKey, 'pr.closed', {}],
  ];
  for (const [i, [subject, kind, payload]] of seeds.entries()) {
    const event = { sourceEventId: `installed-period-${state}-${i}`, subjectKey: subject, kind, payload, classification: 'state-changing', at: i + 1 };
    await journal.append(event); await projector.apply(event);
  }
  const original = await objects.get(subjectKey), issueBefore = await objects.get(issue);
  assert.ok(original.linkedIssues.includes(99));
  const waits = new GitHubWaitStorage(f.facade), done = await waits.create({ id: 'original-period-done', kind: 'pr_tracking', subjectKey,
    userId: 'owner', ownerCatId: 'original-reviewer', threadId: 'original-thread', status: 'done',
    title: 'Ended original wait', why: '', createdBy: 'system', createdAt: 1, updatedAt: 2 });
  await f.runtime.start('instance', f.record);
  const refused = await f.call('github.review.record-verdict', { repoFullName: 'example/project', prNumber: 12,
    reviewedHeadSha: head, verdict: 'approved', summary: 'Native case already ended',
    delivery: { kind: 'delivered', githubUrl: 'https://github.com/example/project/pull/12#pullrequestreview-1' } });
  assert.equal(refused.status, 409);
  const refusal = (await f.call('github.subject.inspect', { subjectKey })).data.lastReviewVerdictFailure;
  await f.call('github.subject.reconcile-terminal', { subjectKey });
  await f.call('github.community-reconciler'); await f.call('github.community-reconciler');
  assert.equal((await objects.get(subjectKey)).state, 'closed', 'fact-only enrollment cannot synthesize historical merge work');
  assert.deepEqual(await objects.get(issue), issueBefore);
  if (state === 'closed') {
    f.mode.scenario = 'provider-open'; await f.call('github.community-reconciler');
    assert.equal((await objects.get(subjectKey)).providerOpen.headSha, 'e'.repeat(40));
    f.mode.scenario = 'provider-merged'; await f.call('github.community-reconciler');
    const after = await objects.get(subjectKey);
    assert.equal(after.state, 'fixed'); assert.equal(after.providerOpen, undefined);
    assert.equal(after.terminalFacts.headSha, 'e'.repeat(40));
    assert.equal((await objects.get(issue)).state, 'fixed');
    await projector.rebuild(subjectKey); assert.deepEqual(await objects.get(subjectKey), after);
  }
  const after = (await f.call('github.subject.inspect', { subjectKey })).data;
  assert.deepEqual(nativeHistory(after.projection.externalReview), nativeHistory(original.externalReview));
  assert.deepEqual(after.lastReviewVerdictFailure, refusal);
  assert.deepEqual(await waits.get(done.id), done); assert.equal(f.sends.length, 0);
  console.log(JSON.stringify({ installedProviderPeriod: state, historicalRepairCreatedNoLifecycleWork: true,
    newPeriodMergeCascade: state === 'closed', nativeHistoryPreserved: true, oldWaitDone: true, notifications: 0 }));
});

test('installed Host records identical same-second closure in its new period and rejects old evidence after restart', async t => {
  const initial = snapshot('closed'); initial.terminalFacts.ci = null;
  const f = await installedTrackingHost(t, { hostRoot, artifact, redisFixture, providerSnapshot: initial });
  const { SdkCommunityEventLog } = await load('business/domains/community/CommunityEventLog.js');
  const { SdkCommunityObjectStore } = await load('business/domains/community/CommunityObjectStore.js');
  const { SdkCommunityRepoConfigStore } = await load('business/domains/community/CommunityRepoConfigStore.js');
  const { CommunityProjector } = await load('business/domains/community/community-projector.js');
  const { GitHubWaitStorage } = await load('typed-wait-storage.js');
  const journal = new SdkCommunityEventLog(f.facade), objects = new SdkCommunityObjectStore(f.facade);
  const projector = new CommunityProjector(journal, objects);
  await new SdkCommunityRepoConfigStore(f.facade).upsert({ repo: 'example/project', guardThreadId: f.thread.id, guardCatId: 'codex61-sol' });
  for (const [i, [kind, payload]] of [
    ['case.external_review_assigned', { mode: 'maintainer_review', cloudPolicy: 'optional', reviewerCatId: 'original-reviewer', reviewerThreadId: 'original-thread' }],
    ['case.head_observed', { headSha: 'a'.repeat(40) }], ['pr.closed', {}],
  ].entries()) {
    const event = { sourceEventId: 'installed-floors-' + i, subjectKey, kind, payload, classification: 'state-changing', at: i + 1 };
    await journal.append(event); await projector.apply(event);
  }
  const native = (await objects.get(subjectKey)).externalReview, waits = new GitHubWaitStorage(f.facade);
  const done = await waits.create({ id: 'original-floor-done', kind: 'pr_tracking', subjectKey, userId: 'owner', ownerCatId: 'original-reviewer',
    threadId: 'original-thread', status: 'done', title: 'Ended original wait', why: '', createdBy: 'system', createdAt: 1, updatedAt: 2 });
  await f.runtime.start('instance', f.record);
  await f.call('github.subject.reconcile-terminal', { subjectKey });
  await f.call('github.community-reconciler'); await f.call('github.community-reconciler');
  f.mode.scenario = 'provider-open-same-second'; await f.call('github.community-reconciler');
  assert.equal((await objects.get(subjectKey)).providerPeriod.state, 'open');
  f.mode.scenario = 'provider-close-same-second'; await f.call('github.community-reconciler');
  const live = await objects.get(subjectKey), committed = await journal.read(subjectKey);
  assert.equal(live.providerOpen, undefined); assert.equal(live.providerPeriod.state, 'closed');
  assert.equal(live.providerPeriod.floorObservedAt, at + 501);
  assert.equal(live.providerPeriod.factsPeriodId, live.providerPeriod.periodId);
  assert.equal(committed.filter(event => event.kind === 'pr.terminal_observed').length, 2);
  await f.call('github.community-reconciler'); assert.deepEqual(await journal.read(subjectKey), committed);
  await f.runtime.stop('instance'); await f.runtime.start('instance', f.record);
  f.mode.scenario = 'provider-old-close';
  await assert.rejects(f.call('github.subject.reconcile-terminal', { subjectKey }), /older than the current provider state/);
  assert.deepEqual(await journal.read(subjectKey), committed);
  await projector.rebuild(subjectKey); assert.deepEqual(await objects.get(subjectKey), live);
  assert.deepEqual(nativeHistory(live.externalReview), nativeHistory(native));
  assert.deepEqual(await waits.get(done.id), done); assert.equal(f.sends.length, 0);
  console.log(JSON.stringify({ installedClockFloors: true, sameSecondCloseRecorded: true, unchangedCoalesced: true,
    staleReconciliationRejectedAfterRestart: true, rebuildMatches: true, oldWaitDone: true, notifications: 0 }));
});

import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { installedTrackingHost } from './installed-tracking-host.mjs';
import { artifactImports } from './installed-tracking-history.mjs';

// Explicitly paired acceptance: never discovers a running Host or its Redis.
const hostRoot = await realpath(process.env.CLOWDER_GITHUB_TERMINAL_HOST_ROOT ?? 'missing-explicit-host-root');
const artifact = await realpath(process.env.CLOWDER_GITHUB_TERMINAL_ARTIFACT_ROOT ?? 'missing-explicit-installed-artifact');
const { ownedRedisFixture } = await import(pathToFileURL(join(hostRoot, 'packages/api/test/helpers/owned-redis-fixture.js')).href);
const redisFixture = ownedRedisFixture('github-terminal-installed');
const load = artifactImports(artifact), head = 'b'.repeat(40), old = 'a'.repeat(40), delivered = 'd'.repeat(40);
const at = Date.parse('2026-11-01T00:00:00Z');
const synthetic = { state: 'merged', headSha: head, ci: 'pass', commentsComplete: true, comments: [],
  reviews: [{ id: 10, author: 'reviewer', state: 'APPROVED', commitId: head, submittedAt: new Date(at - 1000).toISOString() }],
  terminalFacts: { schemaVersion: 1, subjectKey: 'pr:example/project#12', state: 'merged', headSha: head,
    closedAt: new Date(at).toISOString(), mergedAt: new Date(at).toISOString(), mergeCommitSha: 'c'.repeat(40),
    reviews: [{ id: 10, author: 'reviewer', state: 'APPROVED', commitId: head, submittedAt: new Date(at - 1000).toISOString() }],
    ci: { headSha: head, status: 'pass', source: 'github-status-check-rollup', observedAt: at + 1, checkRollup: 'present',
      checks: [{ name: 'gate', bucket: 'pass', providerStatus: 'COMPLETED', providerConclusion: 'SUCCESS' }] },
    source: 'github-api', observedAt: at + 1 } };
const snapshot = process.env.CLOWDER_GITHUB_TERMINAL_SNAPSHOT
  ? JSON.parse(await readFile(process.env.CLOWDER_GITHUB_TERMINAL_SNAPSHOT, 'utf8')) : synthetic;
function nativeHistory(review) {
  const { currentHeadSha, currentHeadObservedAt, headGeneration, ci, cloud, ...history } = review;
  return history;
}

test('fresh tarball → installed SDK → actual Host worker: terminal repair preserves native and done-subscription history', async t => {
  const f = await installedTrackingHost(t, { hostRoot, artifact, redisFixture, providerSnapshot: snapshot });
  const { SdkCommunityEventLog } = await load('business/domains/community/CommunityEventLog.js');
  const { SdkCommunityObjectStore } = await load('business/domains/community/CommunityObjectStore.js');
  const { SdkCommunityRepoConfigStore } = await load('business/domains/community/CommunityRepoConfigStore.js');
  const { CommunityProjector } = await load('business/domains/community/community-projector.js');
  const { GitHubWaitStorage } = await load('typed-wait-storage.js');
  const subjectKey = snapshot.terminalFacts.subjectKey, match = /^pr:(.+)#([0-9]+)$/.exec(subjectKey);
  assert.ok(match); const repo = match[1], number = Number(match[2]);
  const journal = new SdkCommunityEventLog(f.facade), objects = new SdkCommunityObjectStore(f.facade), projector = new CommunityProjector(journal, objects);
  await new SdkCommunityRepoConfigStore(f.facade).upsert({ repo, guardThreadId: f.thread.id, guardCatId: 'codex61-sol', reviewMode: 'maintainer_review' });
  const seeds = [
    ['case.external_review_assigned', { mode: 'maintainer_review', cloudPolicy: 'optional', reviewerCatId: 'original-reviewer', reviewerThreadId: 'original-review-thread' }],
    ['case.head_observed', { headSha: delivered }], ['case.ci_observed', { headSha: delivered, status: 'pass' }],
    ['case.review_ready', { headSha: delivered }],
    ['case.review_verdict_recorded', { headSha: delivered, delivery: { kind: 'delivered', headSha: delivered,
      githubUrl: `https://github.com/${repo}/pull/${number}#pullrequestreview-1`, deliveredAt: 5 } }],
    ['case.head_observed', { headSha: old }], ['case.ci_observed', { headSha: old, status: 'pending' }],
    [snapshot.state === 'merged' ? 'pr.merged' : 'pr.closed', {}],
  ];
  for (const [i, [kind, payload]] of seeds.entries()) {
    const event = { sourceEventId: `terminal-consumer-seed-${i}`, subjectKey, kind, payload,
      classification: kind.startsWith('case.') ? 'informational' : 'state-changing', at: i + 1 };
    await journal.append(event); await projector.apply(event);
  }
  const waits = new GitHubWaitStorage(f.facade);
  const originalWait = await waits.create({ id: 'original-done-subscription', kind: 'pr_tracking', subjectKey,
    userId: 'owner', threadId: f.thread.id, ownerCatId: 'codex61-sol', status: 'done', title: 'Historical subscription',
    why: '', createdBy: 'system', createdAt: 1, updatedAt: 9, automationState: { waitOutcome: {
      v: 1, outcomeId: 'original-subscription:g5:subject_terminal', generation: 5,
      subjectRef: subjectKey, ownerFence: { kind: 'containing_task', generation: 5 },
      reason: 'subject_terminal', terminalSubjectState: snapshot.state, at: 9, delivery: 'delivered', actor: { kind: 'system' },
    } } });
  const native = (await objects.get(subjectKey)).externalReview;
  assert.equal(native.lifecycle, 'terminal'); assert.equal(native.lastDeliveredHeadSha, delivered);
  await f.runtime.start('instance', f.record);
  await f.call('github.community-reconciler'); await f.call('github.community-reconciler');
  const legacy = await f.call('github.subject.inspect', { subjectKey });
  assert.equal(legacy.data.projection.terminalFacts, undefined, 'loading and scheduling cannot enroll unreconciled historical terminal data');
  assert.equal(legacy.data.projection.externalReview.currentHeadSha, old);
  const denied = await f.call('github.review.record-verdict', { repoFullName: repo, prNumber: number,
    reviewedHeadSha: snapshot.headSha, verdict: 'approved', summary: 'Original final review URL',
    delivery: { kind: 'delivered', githubUrl: `https://github.com/${repo}/pull/${number}#pullrequestreview-10` } });
  assert.equal(denied.status, 409, JSON.stringify(denied)); assert.equal(denied.body.error.code, 'subject_terminal');
  const before = await f.call('github.subject.inspect', { subjectKey });
  assert.equal(before.data.lastReviewVerdictFailure.failure.body.outcome, 'not_recorded');
  await assert.rejects(f.call('github.subject.reconcile-terminal', { subjectKey, terminalFacts: {} }));
  const repaired = await f.call('github.subject.reconcile-terminal', { subjectKey });
  assert.equal(repaired.data.terminalFacts.headSha, snapshot.headSha);
  assert.equal(repaired.data.terminalFacts.ci.status, snapshot.terminalFacts.ci.status);
  const after = await f.call('github.subject.inspect', { subjectKey });
  assert.deepEqual(nativeHistory(after.data.projection.externalReview), nativeHistory(native));
  assert.equal(after.data.projection.externalReview.currentHeadSha, snapshot.headSha);
  assert.equal(after.data.projection.externalReview.ci.status, 'pass');
  assert.deepEqual(after.data.lastReviewVerdictFailure, before.data.lastReviewVerdictFailure);
  assert.deepEqual(await waits.get(originalWait.id), originalWait);
  assert.deepEqual(after.data.events.slice(0, before.data.events.length), before.data.events);
  assert.equal(after.data.events.length, before.data.events.length + 1);
  assert.equal(f.sends.length, 0); assert.equal(f.providerCalls(), 1);
  f.mode.scenario = 'terminal-fail'; await f.call('github.community-reconciler');
  const failed = await f.call('github.subject.inspect', { subjectKey });
  assert.equal(failed.data.projection.terminalFacts.ci.status, 'fail');
  assert.equal(failed.data.projection.externalReview.ci.status, 'fail');
  f.mode.scenario = 'terminal-unknown'; await f.call('github.community-reconciler');
  const latest = await f.call('github.subject.inspect', { subjectKey });
  assert.equal(latest.data.projection.terminalFacts.ci.status, 'unknown');
  assert.equal(latest.data.projection.externalReview.ci, null);
  assert.deepEqual(nativeHistory(latest.data.projection.externalReview), nativeHistory(native));
  assert.deepEqual(latest.data.lastReviewVerdictFailure, before.data.lastReviewVerdictFailure);
  await f.runtime.stop('instance', 'candidate-restart-check');
  f.mode.scenario = 'quiet';
  await f.runtime.start('instance', f.record);
  const replay = await f.call('github.subject.reconcile-terminal', { subjectKey });
  assert.equal(replay.data.outcome, 'unchanged');
  const rebuilt = await f.call('github.subject.inspect', { subjectKey });
  assert.deepEqual(rebuilt.data.projection, latest.data.projection);
  assert.deepEqual(rebuilt.data.events, latest.data.events);
  assert.deepEqual(rebuilt.data.lastReviewVerdictFailure, before.data.lastReviewVerdictFailure);
  assert.deepEqual(await waits.get(originalWait.id), originalWait);
  assert.equal(f.sends.length, 0);
  console.log(JSON.stringify({ installedCandidate: true, hostWorker: true, restartAndRebuild: true,
    finalHeadMatches: true, ciSource: repaired.data.terminalFacts.ci.source,
    nativeDeliveredHistoryPreserved: true, oldSubscriptionDone: true, originalNotRecordedRetained: true,
    noAutomaticHistoricalEnrollment: true, scheduledCiChangesObserved: true, notifications: f.sends.length }));
});

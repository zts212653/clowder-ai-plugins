import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginPredicateVerifierContext } from '@clowder-ai/plugin-sdk';
import { CommunityReviewPredicateRuntime, REVIEW_FRESHNESS_METHOD, REVIEW_COMPLETION_METHOD } from './community-review-verifier.js';
import { createExternalReviewAggregate } from './business/domains/community/external-review/external-review-aggregate.js';
import type { CommunityObjectProjection, CommunityRepoConfig } from './business/model/index.js';
import { GitHubProvider } from './github-provider.js';

const head = 'a'.repeat(40), subject = 'pr:example/project#12';
const url = 'https://github.com/example/project/pull/12#pullrequestreview-80';
const input = { actionFamily: 'review', subjectRef: subject, predicate: { kind: 'review_delivered', subjectRef: subject,
  headSha: head, identityKey: 'review_delivered\u001f' + subject, freshnessKey: 'head:' + head, digest: 'b'.repeat(64) } } as const;
function context(phase: 'freshness' | 'completion' = 'freshness'): PluginPredicateVerifierContext {
  const base = { tenantScope: 'owner', installationProjectRoot: '/project', binding: { pluginInstanceId: 'i', packageDigest: 'p', featureId: 'github', contributionId: 'review',
    freshnessMethod: REVIEW_FRESHNESS_METHOD, completionMethod: REVIEW_COMPLETION_METHOD, grantRevision: 1, lifecycleRevision: 1, tenantScope: 'owner', installationProjectRoot: '/project' },
    assignment: { holderCatIds: ['cat'], holderThreadId: 'thread' }, signal: new AbortController().signal, assertCurrent: async () => {} };
  return phase === 'freshness' ? { ...base, phase, principal: { catId: 'author', threadId: 'source', userId: 'owner' } }
    : { ...base, phase, principal: { catId: 'cat', threadId: 'thread', userId: 'owner', invocationId: 'inv' } };
}
function fixture() {
  const aggregate = { ...createExternalReviewAggregate({ mode: 'maintainer_review', cloudPolicy: 'optional', reviewerCatId: 'cat', reviewerThreadId: 'thread' }),
    currentHeadSha: head, currentHeadObservedAt: 1, headGeneration: 1, actionLeaseRef: { leaseId: 'lease', generation: 1 } };
  const projection = { subjectKey: subject, repo: 'example/project', type: 'pr', number: 12, state: 'in_progress', externalReview: aggregate, appliedEventCount: 1 } as CommunityObjectProjection;
  const config = { repo: 'example/project', reviewMode: 'maintainer_review', guardCatId: 'guard', guardThreadId: 'guard-thread', cloudReviewPolicy: 'optional', createdAt: 1, updatedAt: 1 } as CommunityRepoConfig;
  const pr = { number: 12, html_url: 'https://github.com/example/project/pull/12', state: 'open', merged: false, head: { sha: head }, base: { repo: { full_name: 'example/project' } } };
  const review = { id: 80, html_url: url, pull_request_url: 'https://api.github.com/repos/example/project/pulls/12', user: { login: 'publisher' }, body: 'review', state: 'APPROVED', submitted_at: '2026-10-01T12:00:00Z', commit_id: head };
  let hook = (_path: string) => {}; const requests: string[][] = [];
  const provider = new GitHubProvider({ token: async () => 'isolated-predicate-test', log: { warn() {} }, execFileAsync: async (_file, args) => {
    requests.push(args); const path = args[1]!; hook(path);
    return { stdout: JSON.stringify(path.endsWith('/reviews/80') ? review : pr) };
  } });
  const runtime = new CommunityReviewPredicateRuntime({ objectStore: { get: async () => structuredClone(projection) }, repoConfigStore: { getByRepo: async () => structuredClone(config) }, provider });
  return { runtime, projection, config, pr, review, requests, hook: (fn: typeof hook) => { hook = fn; },
    fresh: (ctx = context()) => runtime.predicateVerifiers[REVIEW_FRESHNESS_METHOD]!(input, ctx),
    complete: () => runtime.predicateVerifiers[REVIEW_COMPLETION_METHOD]!({ ...input, leaseId: 'lease', generation: 1, evidenceRefs: ['github:' + url] }, context('completion')) };
}

test('freshness verifies real provider HEAD and returns private assignment, not admission actor', async () => {
  const f = fixture();
  assert.deepEqual(await f.fresh(), { status: 'verified', evidenceRef: 'github:example/project#12:head:' + head, freshnessKey: input.predicate.freshnessKey, ownerCatId: 'cat', holderThreadId: 'thread' });
  assert.equal(f.requests.length, 1);
  assert.ok(f.requests.every(args => !args.includes('POST')));
});

test('freshness refuses private assignment, policy, generation and terminal mismatches', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { (f.projection.externalReview as any).reviewerCatId = 'other'; },
    (f: ReturnType<typeof fixture>) => { (f.projection.externalReview as any).reviewerThreadId = 'other'; },
    (f: ReturnType<typeof fixture>) => { (f.projection.externalReview as any).headGeneration = 0; },
    (f: ReturnType<typeof fixture>) => { (f.projection.externalReview as any).lifecycle = 'terminal'; },
    (f: ReturnType<typeof fixture>) => { (f.config as any).reviewMode = 'observe_only'; },
    (f: ReturnType<typeof fixture>) => { f.projection.repo = 'other/project'; },
  ]) {
    const f = fixture(); mutate(f); assert.notEqual((await f.fresh()).status, 'verified'); assert.equal(f.requests.length, 0);
  }
});

test('provider movement, closure, failure and cancellation never verify', async () => {
  for (const mode of ['head', 'closed', 'failure', 'abort', 'stop'] as const) {
    const f = fixture(), controller = new AbortController();
    f.hook(() => { if (mode === 'head') f.pr.head.sha = 'c'.repeat(40); if (mode === 'closed') f.pr.state = 'closed';
      if (mode === 'failure') throw new Error('unavailable'); if (mode === 'abort') controller.abort(); if (mode === 'stop') f.runtime.stop(); });
    const result = await f.fresh({ ...context(), signal: controller.signal }).catch(() => ({ status: 'rejected' }));
    assert.notEqual(result.status, 'verified');
  }
});

test('freshness rereads private state and policy after provider IO', async () => {
  for (const mode of ['assignment', 'generation', 'lease', 'policy', 'event'] as const) {
    const f = fixture(); f.hook(() => {
      const review = f.projection.externalReview as any;
      if (mode === 'assignment') review.reviewerCatId = 'other'; if (mode === 'generation') review.headGeneration++;
      if (mode === 'lease') review.actionLeaseRef.generation++; if (mode === 'policy') (f.config as any).reviewMode = 'observe_only';
      if (mode === 'event') f.projection.appliedEventCount++;
    });
    assert.notEqual((await f.fresh()).status, 'verified');
  }
});

test('completion requires a durable exact submission and never promotes URL or login into publisher association', async () => {
  const f = fixture(); assert.notEqual((await f.complete()).status, 'verified'); assert.equal(f.requests.length, 0);
  (f.projection.externalReview as any).pendingVerdict = { fingerprint: 'intent', headSha: head, headGeneration: 1, verdict: 'approved', summary: 'review', userNudgeRequired: false,
    delivery: { kind: 'delivered', headSha: head, githubUrl: url, deliveredAt: 1 }, principal: { catId: 'cat', threadId: 'thread' }, actionLeaseRef: { leaseId: 'lease', generation: 1 }, verificationReason: 'ci_pending', submittedAt: 1 };
  const before = structuredClone(f.projection);
  assert.deepEqual(await f.complete(), { status: 'insufficient', reason: 'publisher_association_unavailable' });
  assert.deepEqual(f.projection, before, 'verifier is read-only');
  assert.ok(f.requests.some(args => args[1]!.endsWith('/reviews/80')));
  f.review.commit_id = 'c'.repeat(40); assert.notEqual((await f.complete()).status, 'verified');
});

test('completion rereads submission and lease after exact provider IO', async () => {
  for (const field of ['principal', 'lease', 'delivery', 'generation'] as const) {
    const f = fixture();
    (f.projection.externalReview as any).pendingVerdict = { fingerprint: 'intent', headSha: head, headGeneration: 1,
      verdict: 'approved', summary: 'review', userNudgeRequired: false, delivery: { kind: 'delivered', headSha: head, githubUrl: url, deliveredAt: 1 },
      principal: { catId: 'cat', threadId: 'thread' }, actionLeaseRef: { leaseId: 'lease', generation: 1 }, verificationReason: 'ci_pending', submittedAt: 1 };
    f.hook(path => { if (!path.endsWith('/reviews/80')) return;
      const review = f.projection.externalReview as any;
      if (field === 'principal') review.pendingVerdict.principal.catId = 'other';
      if (field === 'lease') review.actionLeaseRef.generation++;
      if (field === 'delivery') review.pendingVerdict.delivery.githubUrl = url + '1';
      if (field === 'generation') review.headGeneration++;
    });
    const result = await f.complete(); assert.equal(result.status, 'mismatch');
  }
});

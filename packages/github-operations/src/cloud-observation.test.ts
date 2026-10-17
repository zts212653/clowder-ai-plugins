import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyExternalCloudReview } from './business/domains/community/external-review/external-cloud-review-classifier.js';

const head = 'a'.repeat(40);
const request = { headSha: head, triggerCommentId: 10, requestedAt: Date.parse('2026-10-08T10:00:00Z') };
const trigger = { id: 10, author: 'owner', body: '@codex review', commentType: 'conversation' as const, createdAt: '2026-10-08T10:00:00Z' };
const review = { id: 20, author: 'chatgpt-codex-connector[bot]', state: 'COMMENTED' as const, body: '', commitId: head, submittedAt: '2026-10-08T10:01:00Z' };
const input = { currentHeadSha: head, request, commentsComplete: true, comments: [trigger], reviews: [review],
  knownCloudReviewerLogins: [review.author], now: request.requestedAt + 120_000, timeoutMs: 30 * 60_000 };

test('cloud provider classification uses an explicit observation request, not Host await/custody state', () => {
  const result = classifyExternalCloudReview(input);
  assert.equal(result.observation?.status, 'clean');
  assert.deepEqual(result.correlatedReviewIds, [20]);
  assert.equal('waitResult' in result, false, 'no continuation or wait result contract is exported');
});

test('incremental evidence cannot prove clean, including a repeat poll after a finding cursor advanced', () => {
  assert.equal(classifyExternalCloudReview({ ...input, commentsComplete: false }).observation, null);
  const finding = { id: 30, author: review.author, body: 'P2', commentType: 'inline' as const,
    commitId: head, reviewId: 20, createdAt: review.submittedAt };
  assert.equal(classifyExternalCloudReview({ ...input, comments: [trigger, finding] }).observation?.status, 'blocking');
  assert.equal(classifyExternalCloudReview({ ...input, comments: [trigger], commentsComplete: false }).observation, null);
});

test('stale HEAD, missing trigger and older same-HEAD decisions cannot settle the request', () => {
  assert.equal(classifyExternalCloudReview({ ...input, currentHeadSha: 'b'.repeat(40) }).observation, null);
  assert.equal(classifyExternalCloudReview({ ...input, comments: [] }).observation, null);
  assert.equal(classifyExternalCloudReview({ ...input, reviews: [{ ...review, submittedAt: '2026-10-08T09:59:00Z' }] }).observation?.status, 'running');
  assert.equal(classifyExternalCloudReview({ ...input, request: { ...request, requestedAt: 1 } }).observation, null);
});

test('canonical clean conversation requires one exact reviewed-commit line, known author and post-trigger evidence', () => {
  const comment = { ...trigger, id: 11, author: review.author, createdAt: review.submittedAt,
    body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `aaaaaaaa`" };
  assert.equal(classifyExternalCloudReview({ ...input, reviews: [], comments: [trigger, comment] }).observation?.status, 'clean');
  for (const bad of [{ ...comment, author: 'random-user' }, { ...comment, body: comment.body + '\n**Reviewed commit:** `aaaaaaaa`' },
    { ...comment, body: comment.body.replace('aaaaaaaa', 'bbbbbbbb') }]) {
    assert.equal(classifyExternalCloudReview({ ...input, reviews: [], comments: [trigger, bad] }).observation?.status, 'running');
  }
  assert.equal(classifyExternalCloudReview({ ...input, reviews: [], now: request.requestedAt + input.timeoutMs }).observation?.status, 'failed_or_timeout');
  assert.equal(classifyExternalCloudReview({ ...input, reviews: [{ ...review, state: 'DISMISSED' }] }).observation?.status, 'failed_or_timeout');
});

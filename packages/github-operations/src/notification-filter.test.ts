import assert from 'node:assert/strict';
import test from 'node:test';
import { readNotificationFilter } from './notification-filter.js';
import type { GitHubSnapshot } from './tracking-runtime.js';

for (const mode of ['allow', 'block'] as const) {
  test(`${mode} policy resolves conversation evidence separately from an unrelated review with the same ID`, async () => {
    const snapshot: GitHubSnapshot = { state: 'open',
      comments: [{ id: 7, author: 'comment-author', body: 'clean review', commentType: 'conversation' }],
      reviews: [{ id: 7, author: 'review-author', state: 'COMMENTED' }] };
    const allowed = await readNotificationFilter({ config: { get: async key =>
      key === (mode === 'allow' ? 'notificationAllowlist' : 'notificationBlocklist') ? 'comment-author' : '' } }, snapshot, 'fallback-reviewer');
    assert.equal(allowed({ kind: 'pr_review_result_available', delta: 'clean', sourceRef: 'conversation:7' }), mode === 'allow');
    assert.equal(allowed({ kind: 'pr_review_result_available', delta: 'result', sourceRef: 'review:7' }), mode === 'block');
  });
}

test('inline and conversation comments with the same numeric ID retain their own actor policy', async () => {
  const snapshot: GitHubSnapshot = { state: 'open', reviews: [], comments: [
    { id: 7, author: 'blocked-bot', body: 'conversation', commentType: 'conversation' },
    { id: 7, author: 'allowed-reviewer', body: 'inline', commentType: 'inline' },
  ] };
  const allowed = await readNotificationFilter({ config: { get: async key => key === 'notificationAllowlist' ? 'allowed-reviewer' : '' } }, snapshot);
  assert.equal(allowed({ kind: 'pr_inline_comment_added', delta: 'inline', sourceRef: 'github:pr-comment:7' }), true);
  assert.equal(allowed({ kind: 'pr_conversation_comment_added', delta: 'conversation', sourceRef: 'github:pr-comment:7' }), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubProvider } from './github-provider.js';

const repo = 'example/project';
const prNumber = 12;
const headSha = 'a'.repeat(40);
const base = `https://github.com/${repo}/pull/${prNumber}`;
const api = `https://api.github.com/repos/${repo}`;
const time = '2026-10-01T12:00:00Z';
const signal = () => new AbortController().signal;
function fixture() {
  const calls: string[][] = [];
  const pr = { number: prNumber, html_url: base, state: 'open', merged: false,
    head: { sha: headSha }, base: { repo: { full_name: repo } } };
  const review = { id: 80, html_url: `${base}#pullrequestreview-80`, pull_request_url: `${api}/pulls/12`,
    user: { login: 'reviewer' }, body: '', state: 'APPROVED', submitted_at: time, commit_id: headSha };
  const inline = { id: 81, html_url: `${base}#discussion_r81`, pull_request_url: `${api}/pulls/12`,
    user: { login: 'reviewer' }, body: 'Please fix this', created_at: time, commit_id: headSha,
    original_commit_id: headSha, pull_request_review_id: 80 };
  const comment = { id: 82, html_url: `${base}#issuecomment-82`, issue_url: `${api}/issues/12`,
    user: { login: 'reviewer' }, body: 'Reviewed', created_at: time };
  let beforeReply: (path: string) => void = () => {};
  const provider = new GitHubProvider({ token: async () => 'isolated-review-evidence', log: { warn() {} },
    execFileAsync: async (_file, args) => {
      calls.push(args); const path = args[1]!; beforeReply(path);
      const value = path === `/repos/${repo}/pulls/12` ? pr
        : path === `/repos/${repo}/pulls/12/reviews/80` ? review
        : path === `/repos/${repo}/pulls/comments/81` ? inline
        : path === `/repos/${repo}/issues/comments/82` ? comment : undefined;
      if (!value) throw new Error(`Unexpected request ${path}`);
      return { stdout: JSON.stringify(value) };
    } });
  return { provider, calls, pr, review, inline, comment, beforeReply: (hook: typeof beforeReply) => { beforeReply = hook; } };
}

test('review evidence reads live PR identity and preserves terminal states', async () => {
  const f = fixture();
  assert.deepEqual(await f.provider.observeReviewHead({ repo, prNumber }, signal()), { repo, prNumber, headSha, state: 'open' });
  f.pr.state = 'closed';
  assert.equal((await f.provider.observeReviewHead({ repo, prNumber }, signal()))?.state, 'closed');
  f.pr.merged = true;
  assert.equal((await f.provider.observeReviewHead({ repo, prNumber }, signal()))?.state, 'merged');
  f.pr.number = 13;
  assert.equal(await f.provider.observeReviewHead({ repo, prNumber }, signal()), null);
});

test('exact delivered review is fetched from its PR endpoint and bracketed by fresh HEAD reads', async () => {
  const f = fixture();
  const result = await f.provider.observeReviewDelivery({ repo, prNumber, url: f.review.html_url }, signal());
  assert.equal(result?.delivery.kind, 'review');
  assert.equal(result?.delivery.commitSha, headSha);
  assert.equal(result?.delivery.authorLogin, 'reviewer');
  assert.equal(result?.delivery.body, '', 'an APPROVED review need not contain body text');
  assert.deepEqual(f.calls.map(args => args[1]), [`/repos/${repo}/pulls/12`, `/repos/${repo}/pulls/12/reviews/80`, `/repos/${repo}/pulls/12`]);
  assert.ok(f.calls.every(args => args.includes('--hostname') && args.includes('github.com') && !args.includes('POST')));
});

test('inline evidence checks its submitted parent review and retains original commit separately', async () => {
  const f = fixture(); f.inline.original_commit_id = 'b'.repeat(40);
  const result = await f.provider.observeReviewDelivery({ repo, prNumber, url: `${base}/files#r81` }, signal());
  assert.equal(result?.delivery.kind, 'review_comment');
  if (result?.delivery.kind !== 'review_comment') assert.fail('missing inline observation');
  assert.equal(result.delivery.originalCommitSha, 'b'.repeat(40));
  assert.equal(result.delivery.reviewId, 80);
  f.review.state = 'PENDING';
  assert.equal(await f.provider.observeReviewDelivery({ repo, prNumber, url: f.inline.html_url }, signal()), null);
});

test('PR conversation comment is an observed delivery, never a provider commit binding', async () => {
  const f = fixture();
  const result = await f.provider.observeReviewDelivery({ repo, prNumber, url: f.comment.html_url }, signal());
  assert.equal(result?.delivery.kind, 'issue_comment');
  assert.equal(result?.delivery.commitSha, null);
  assert.equal(result?.head.headSha, headSha);
});

test('malformed subjects and delivery URLs cannot cause arbitrary provider requests', async () => {
  const urls = ['not-a-url', `${base}?q=1#pullrequestreview-80`, `${base}#pullrequestreview-080`,
    `${base}#pullrequestreview-9007199254740992`, `${base}/../12#pullrequestreview-80`,
    base.replace('/pull/', '/issues/') + '#issuecomment-82', `${base}%2f#pullrequestreview-80`,
    `https://user@github.com/${repo}/pull/12#pullrequestreview-80`, `${base.replace('github.com', 'evil.test')}#pullrequestreview-80`,
    `${base.replace('https:', 'http:')}#pullrequestreview-80`, `${base}#pullrequestreview-80\n`];
  for (const url of urls) {
    const f = fixture();
    assert.equal(await f.provider.observeReviewDelivery({ repo, prNumber, url }, signal()), null, url);
    assert.equal(f.calls.length, 0, url);
  }
  for (const badRepo of ['../project', 'example/..', 'example/project/other', 'example/%2f', 'example/project\n']) {
    const f = fixture();
    assert.equal(await f.provider.observeReviewHead({ repo: badRepo, prNumber }, signal()), null);
    assert.equal(f.calls.length, 0);
  }
});

test('provider object identity, parent, state and content mismatches fail closed', async () => {
  const edits: Array<(f: ReturnType<typeof fixture>) => string> = [
    f => { f.review.id = 79; return f.review.html_url; },
    f => { f.review.pull_request_url = `${api}/pulls/13`; return f.review.html_url; },
    f => { f.review.html_url = `${base}#pullrequestreview-79`; return `${base}#pullrequestreview-80`; },
    f => { f.review.state = 'DISMISSED'; return f.review.html_url; },
    f => { f.review.submitted_at = ''; return f.review.html_url; },
    f => { f.review.commit_id = 'short'; return f.review.html_url; },
    f => { f.review.commit_id = headSha + '\n'; return f.review.html_url; },
    f => { f.inline.pull_request_url = `${api}/pulls/13`; return f.inline.html_url; },
    f => { f.inline.user.login = 'other'; return f.inline.html_url; },
    f => { f.comment.issue_url = `${api}/issues/13`; return f.comment.html_url; },
    f => { f.comment.body = ' '; return f.comment.html_url; },
    f => { f.comment.user.login = ''; return f.comment.html_url; },
  ];
  for (const edit of edits) {
    const f = fixture(); const url = edit(f);
    assert.equal(await f.provider.observeReviewDelivery({ repo, prNumber, url }, signal()), null);
  }
});

test('HEAD movement or PR close during delivery GET produces no coherent observation', async () => {
  for (const change of [(f: ReturnType<typeof fixture>) => { f.pr.head.sha = 'b'.repeat(40); },
    (f: ReturnType<typeof fixture>) => { f.pr.state = 'closed'; }]) {
    const f = fixture();
    f.beforeReply(path => { if (path.endsWith('/reviews/80')) change(f); });
    assert.equal(await f.provider.observeReviewDelivery({ repo, prNumber, url: f.review.html_url }, signal()), null);
  }
});

test('stale review commit stays explicit instead of being relabelled with current PR HEAD', async () => {
  const f = fixture(); f.review.commit_id = 'b'.repeat(40);
  const result = await f.provider.observeReviewDelivery({ repo, prNumber, url: f.review.html_url }, signal());
  assert.equal(result?.head.headSha, headSha);
  assert.equal(result?.delivery.commitSha, 'b'.repeat(40));
});

test('provider failure and cancelled invocation cannot turn into a delivery observation', async () => {
  const f = fixture();
  f.beforeReply(() => { throw new Error('provider unavailable'); });
  await assert.rejects(f.provider.observeReviewDelivery({ repo, prNumber, url: f.review.html_url }, signal()), /provider unavailable/);
  const g = fixture(); const controller = new AbortController();
  g.beforeReply(path => { if (path.endsWith('/reviews/80')) controller.abort(); });
  await assert.rejects(g.provider.observeReviewDelivery({ repo, prNumber, url: g.review.html_url }, controller.signal));
  assert.equal(g.calls.length, 2, 'no post-abort followup');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { CommunityRouteProvider } from './community-route-provider.js';

const issue = (number: number, isPullRequest = false) => ({ number, title: 'Issue', state: 'open', labels: ['bug'], comments: 0, user: 'author', html_url: `https://github.com/org/repo/${isPullRequest ? 'pull' : 'issues'}/${number}`, isPullRequest });
function fixture(pages: unknown[][], options: { allowed?: () => Promise<boolean>; token?: () => Promise<string>; current?: () => Promise<void> } = {}) {
  const calls: string[][] = [];
  const provider = new CommunityRouteProvider({ token: options.token ?? (async () => 'isolated-community-route-provider'),
    allowed: options.allowed ?? (async () => true), assertCurrent: options.current ?? (async () => {}),
    execFileAsync: async (_file, args) => { calls.push(args); const page = Number(new URL(args[1]!).searchParams.get('page')); const rows = pages[page - 1]; if (!rows) throw new Error('provider unavailable'); return { stdout: rows.map(row => JSON.stringify(row)).join('\n') }; } });
  return { provider, calls };
}
test('issue sync counts every provider row for pagination before excluding PR rows', async () => {
  const f = fixture([Array.from({ length: 100 }, (_, i) => issue(i + 1, i < 99)), [issue(101)]]);
  try {
    const rows = await f.provider.fetchIssues('ORG/repo'); assert.deepEqual(rows.map(x => x.number), [100, 101]);
    assert.equal(f.calls.length, 2); assert.ok(f.calls.every(args => !args.includes('--paginate') && args.includes('--hostname') && args.includes('GET')));
    assert.equal(new URL(f.calls[0]![1]!).searchParams.get('state'), 'all');
  } finally { await f.provider.stop(); }
});
test('invalid or unconfigured repo is refused before credentials or provider IO', async () => {
  let credentials = 0;
  const f = fixture([], { token: async () => { credentials++; return 'never'; }, allowed: async () => false });
  for (const repo of ['../repo', 'org/repo?evil=1', 'org/repo\n', 'org/repo']) await assert.rejects(f.provider.fetchIssues(repo));
  assert.equal(credentials, 0); assert.equal(f.calls.length, 0); await f.provider.stop();
});
test('partial pagination and foreign issue URL fail without returning a partial or empty success', async () => {
  for (const pages of [[Array.from({ length: 100 }, (_, i) => issue(i + 1))], [[{ ...issue(1), html_url: 'https://github.com/other/repo/issues/1' }]]]) {
    const f = fixture(pages); await assert.rejects(f.provider.fetchIssues('org/repo')); await f.provider.stop();
  }
});
test('policy change during read and caller invalidation after credentials both fail closed', async () => {
  let policy = 0;
  const f = fixture([[issue(1)]], { allowed: async () => ++policy === 1 });
  await assert.rejects(f.provider.fetchIssues('org/repo')); await f.provider.stop();
  let valid = true;
  const g = fixture([[issue(1)]], { token: async () => { valid = false; return 'isolated'; }, current: async () => { if (!valid) throw new Error('stale'); } });
  await assert.rejects(g.provider.fetchIssues('org/repo'), /stale/); assert.equal(g.calls.length, 0); await g.provider.stop();
});
test('repository revocation after a full page prevents the next authenticated request', async () => {
  let allowed = true, calls = 0;
  const provider = new CommunityRouteProvider({ token: async () => 'isolated-policy-revocation',
    allowed: async () => allowed, assertCurrent: async () => {},
    execFileAsync: async () => {
      calls++;
      allowed = false;
      return { stdout: calls === 1 ? Array.from({ length: 100 }, (_, i) => JSON.stringify(issue(i + 1))).join('\n') : '' };
    } });
  try {
    await assert.rejects(provider.fetchIssues('org/repo'), /Repository policy changed/);
    assert.equal(calls, 1, 'revocation must be observed before requesting page 2');
  } finally { await provider.stop(); }
});
test('stop during credential read prevents any late request or result', async () => {
  let entered!: () => void, release!: () => void;
  const start = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const f = fixture([[issue(1)]], { token: async () => { entered(); await gate; return 'late'; } });
  const pending = assert.rejects(f.provider.fetchIssues('org/repo')); await start;
  const stopped = f.provider.stop(); release(); await Promise.all([pending, stopped]); assert.equal(f.calls.length, 0);
});

test('PR metadata, submitted reviews and cursor reads preserve only their provider fields', async () => {
  const head = 'a'.repeat(40);
  const f = fixture([[{ number: 1, title: 'PR', state: 'closed', merged_at: '2026-10-01T00:00:00Z', user: 'author', head_sha: head, draft: false, labels: ['bug'], updated_at: '2026-10-01T00:00:00Z' }]]);
  assert.equal((await f.provider.fetchPrs('org/repo'))[0]?.head_sha, head); await f.provider.stop();
  const g = fixture([[{ state: 'PENDING', commit_id: null, submitted_at: null }, { user: 'reviewer', state: 'APPROVED', commit_id: head, submitted_at: '2026-10-01T00:00:00Z' }]]);
  assert.deepEqual(await g.provider.fetchPrReviews('org/repo', 1), [{ user: 'reviewer', state: 'APPROVED', commit_id: head }]); await g.provider.stop();
  const h = fixture([[{ id: 2 }, { id: 7 }, { id: 3 }]]);
  assert.equal(await h.provider.fetchIssueCommentCursor('org/repo', 1), 7); await h.provider.stop();
});

test('malformed review and unsafe cursor cannot become workflow observations', async () => {
  const f = fixture([[{ user: 'reviewer', state: 'APPROVED', commit_id: null, submitted_at: null }]]);
  await assert.rejects(f.provider.fetchPrReviews('org/repo', 1)); await f.provider.stop();
  const g = fixture([[{ id: Number.MAX_SAFE_INTEGER + 1 }]]);
  await assert.rejects(g.provider.fetchIssueCommentCursor('org/repo', 1)); await g.provider.stop();
});

test('stop joins a provider read and rejects its late result', async () => {
  let entered!: () => void, release!: () => void, closed = false;
  const start = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const provider = new CommunityRouteProvider({ token: async () => 'isolated-provider-stop', allowed: async () => true, assertCurrent: async () => {},
    execFileAsync: async () => { entered(); await gate; closed = true; return { stdout: JSON.stringify(issue(1)) }; } });
  const pending = assert.rejects(provider.fetchIssues('org/repo')); await start;
  let stopped = false;
  const stop = provider.stop().then(() => { assert.equal(closed, true); stopped = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(stopped, false);
  release(); await Promise.all([pending, stop]);
});

test('exact public comment verification binds object, parent and content under live repository policy', async () => {
  let allowed = true, calls = 0, credentials = 0;
  const input = { repo: 'org/repo', issueNumber: 1, url: 'https://github.com/org/repo/issues/1#issuecomment-42' };
  let value = { id: 42, html_url: input.url, issue_url: 'https://api.github.com/repos/org/repo/issues/1', body: 'Published reply' };
  const provider = new CommunityRouteProvider({ allowed: async () => allowed, assertCurrent: async () => {}, token: async () => { credentials++; return 'isolated-comment'; },
    execFileAsync: async (_file, args) => { calls++; assert.equal(args[1], 'https://api.github.com/repos/org/repo/issues/comments/42'); return { stdout: JSON.stringify(value) }; } });
  try {
    assert.equal(await provider.verifyPublicIssueComment({ ...input, url: 'https://github.com/other/repo/issues/1#issuecomment-42' }), false);
    assert.equal(credentials, 0); assert.equal(calls, 0);
    assert.equal(await provider.verifyPublicIssueComment(input), true);
    value = { ...value, issue_url: 'https://api.github.com/repos/org/repo/issues/2' };
    assert.equal(await provider.verifyPublicIssueComment(input), false);
    allowed = false; await assert.rejects(provider.verifyPublicIssueComment(input), /not configured/); assert.equal(calls, 2);
  } finally { await provider.stop(); }
});
test('public comment read rejects revoked policy and stop joins the in-flight request', async () => {
  let allowed = true, started!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { started = r; }), gate = new Promise<void>(r => { release = r; });
  const input = { repo: 'org/repo', issueNumber: 1, url: 'https://github.com/org/repo/issues/1#issuecomment-42' };
  const value = { id: 42, html_url: input.url, issue_url: 'https://api.github.com/repos/org/repo/issues/1', body: 'Reply' };
  const revoked = new CommunityRouteProvider({ allowed: async () => allowed, assertCurrent: async () => {}, token: async () => 'isolated-revocation', execFileAsync: async () => { allowed = false; return { stdout: JSON.stringify(value) }; } });
  await assert.rejects(revoked.verifyPublicIssueComment(input), /policy changed/); await revoked.stop();
  const stopped = new CommunityRouteProvider({ allowed: async () => true, assertCurrent: async () => {}, token: async () => 'isolated-stop', execFileAsync: async (_file, _args, options) => {
    started(); await gate; assert.equal(options.signal!.aborted, true); return { stdout: JSON.stringify(value) };
  } });
  const pending = assert.rejects(stopped.verifyPublicIssueComment(input)); await entered;
  let joined = false; const stop = stopped.stop().then(() => { joined = true; });
  await new Promise(r => setImmediate(r)); assert.equal(joined, false);
  release(); await Promise.all([pending, stop]);
});

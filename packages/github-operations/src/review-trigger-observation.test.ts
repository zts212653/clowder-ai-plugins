import assert from 'node:assert/strict';
import test from 'node:test';
import { ReviewTriggerReader } from './review-trigger-observation.js';
import type { GitHubRequestOptions } from './business/infrastructure/github/request-budget.js';

const input = { repoFullName: 'Owner/Repo', prNumber: 42, triggerCommentId: 77 };
const bot = { login: 'chatgpt-codex-connector[bot]', type: 'Bot' };
const at = '2026-10-09T00:00:00Z';
function fixture() {
  const calls: string[][] = [];
  const comment: Record<string, unknown> = { id: 77, body: ' @codex review',
    issue_url: 'https://api.github.com/repos/owner/repo/issues/42', created_at: at };
  const pages = new Map<string, unknown[]>();
  pages.set('reactions:1', [{ content: 'eyes', user: bot }]);
  let failure = '';
  const exec: NonNullable<GitHubRequestOptions['execFileAsync']> = async (file, args) => {
    assert.equal(file, 'gh'); assert.equal(args[0], 'api');
    assert.ok(args[1]?.startsWith('https://api.github.com/repos/Owner/Repo/'));
    assert.ok(!args.includes('POST') && !args.includes('PATCH') && !args.includes('DELETE'));
    calls.push(args);
    const url = new URL(args[1]!);
    if (url.pathname.endsWith('/issues/comments/77')) return { stdout: JSON.stringify(comment) };
    const kind = url.pathname.endsWith('/reactions') ? 'reactions' :
      url.pathname.endsWith('/reviews') ? 'reviews' : url.pathname.includes('/pulls/') ? 'inline' : 'conversation';
    const key = `${kind}:${url.searchParams.get('page')}`;
    if (key === failure) throw new Error('page unavailable');
    return { stdout: (pages.get(key) ?? []).map(row => JSON.stringify(row)).join('\n') };
  };
  const reader = new ReviewTriggerReader({ token: async () => 'isolated-exact-trigger', execFileAsync: exec, now: () => 123 });
  return { reader, calls, comment, pages, fail: (key: string) => { failure = key; } };
}

test('exact trigger observation returns no authority and performs only bounded provider reads', async () => {
  const f = fixture();
  assert.deepEqual(await f.reader.observe(input), { covered: true, triggerCommentId: 77, observedAt: 123 });
  assert.equal(f.calls.length, 5);
  await f.reader.stop();
  await assert.rejects(f.reader.observe(input), /stopped/);
  assert.equal(f.calls.length, 5);
});

test('invalid or authority-bearing input is rejected before token or provider access', async () => {
  let reads = 0;
  const reader = new ReviewTriggerReader({ token: async () => { reads++; return 'no'; } });
  for (const value of [null, [], {}, { ...input, covered: true }, { ...input, catId: 'owner' },
    { ...input, repoFullName: '../repo' }, { ...input, prNumber: 0 }, { ...input, triggerCommentId: 1.2 }]) {
    await assert.rejects(reader.observe(value));
  }
  assert.equal(reads, 0); await reader.stop();
});

test('comment subject and command must match; bad timestamp is an unavailable query', async () => {
  for (const delta of [{ id: 78 }, { issue_url: 'https://api.github.com/repos/else/repo/issues/42' },
    { issue_url: 'https://api.github.com/repos/owner/repo/issues/43' },
    { issue_url: 'https://forged.test/repos/owner/repo/issues/42' }, { body: '@codex reviewer' },
    { created_at: 'invalid' }]) {
    const f = fixture(); Object.assign(f.comment, delta);
    if ('created_at' in delta) await assert.rejects(f.reader.observe(input), /timestamp/);
    else assert.deepEqual(await f.reader.observe(input), { covered: false,
      reason: 'body' in delta ? 'not_review_trigger' : 'subject_mismatch', triggerCommentId: 77, observedAt: 123 });
    assert.equal(f.calls.length, 1); await f.reader.stop();
  }
});

test('EYES requires exact connector login and Bot type, including later pages', async () => {
  for (const user of [{ ...bot, type: 'User' }, { ...bot, login: 'other[bot]' }]) {
    const f = fixture(); f.pages.set('reactions:1', [{ content: 'eyes', user }]);
    assert.equal((await f.reader.observe(input)).covered, false); await f.reader.stop();
  }
  const f = fixture(); f.pages.set('reactions:1', Array.from({ length: 100 }, () => ({ content: '+1', user: bot })));
  f.pages.set('reactions:2', [{ content: 'eyes', user: { ...bot, login: bot.login.toUpperCase() } }]);
  assert.equal((await f.reader.observe(input)).covered, true); await f.reader.stop();
});

test('all three feedback streams check later pages and exact trigger-time equality', async () => {
  for (const kind of ['reviews', 'inline', 'conversation']) {
    const f = fixture(); f.pages.set(`${kind}:1`, Array.from({ length: 100 }, () => ({ user: { login: 'human', type: 'User' } })));
    f.pages.set(`${kind}:2`, [{ user: bot, submitted_at: at, created_at: at }]);
    assert.deepEqual(await f.reader.observe(input), { covered: false, reason: 'feedback_already_posted', triggerCommentId: 77, observedAt: 123 });
    await f.reader.stop();
  }
});

test('old or impersonated feedback is not coverage; corrupt or incomplete feedback never returns covered', async () => {
  const f = fixture(); f.pages.set('reviews:1', [
    { user: bot, submitted_at: '2026-10-08T00:00:00Z' },
    { user: { ...bot, type: 'User' }, submitted_at: at },
  ]);
  assert.equal((await f.reader.observe(input)).covered, true);
  f.pages.set('reviews:1', [{ user: bot, submitted_at: 'bad' }]);
  await assert.rejects(f.reader.observe(input), /timestamp/);
  f.pages.set('reviews:1', Array.from({ length: 100 }, () => ({ user: { login: 'human', type: 'User' } })));
  f.fail('reviews:2'); await assert.rejects(f.reader.observe(input), /page unavailable/);
  await f.reader.stop();
});

test('stop aborts the provider and joins its cleanup before resolving', async () => {
  let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
  let finish!: () => void; let aborted = false;
  const reader = new ReviewTriggerReader({ token: async () => 'isolated-trigger-stop', execFileAsync: async (_file, _args, opts) => {
    started(); await new Promise<void>(resolve => { finish = resolve; opts.signal!.addEventListener('abort', () => { aborted = true; }, { once: true }); });
    return { stdout: '{}' };
  } });
  const query = assert.rejects(reader.observe(input)); await entered;
  let stopped = false; const stop = reader.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aborted, true); assert.equal(stopped, false);
  finish(); await Promise.all([query, stop]); assert.equal(stopped, true);
});

test('a deadline aborts and awaits process cleanup, never returning partial evidence', async () => {
  let cleaned = false;
  const reader = new ReviewTriggerReader({ token: async () => 'isolated-trigger-deadline', timeoutMs: 10,
    execFileAsync: async (_file, _args, opts) => {
      await new Promise<void>(resolve => {
        opts.signal!.addEventListener('abort', () => { setTimeout(() => { cleaned = true; resolve(); }, 5); }, { once: true });
      });
      return { stdout: '{}' };
    },
  });
  await assert.rejects(reader.observe(input), /timed out/);
  assert.equal(cleaned, true); await reader.stop();
});

test('stop also releases a query still waiting for its secret read', async () => {
  let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
  const reader = new ReviewTriggerReader({ token: () => { started(); return new Promise(() => {}); } });
  const query = assert.rejects(reader.observe(input), /stopped/);
  await entered; await reader.stop(); await query;
});

test('reaction-page failure after EYES, corrupt JSON and pagination exhaustion refuse coverage', async () => {
  const f = fixture();
  f.pages.set('reactions:1', Array.from({ length: 100 }, () => ({ content: 'eyes', user: bot })));
  f.fail('reactions:2'); await assert.rejects(f.reader.observe(input), /page unavailable/); await f.reader.stop();
  for (const mode of ['corrupt', 'full']) {
    let pages = 0;
    const reader = new ReviewTriggerReader({ token: async () => `isolated-trigger-${mode}`, execFileAsync: async (_file, args) => {
      if (args[1]!.endsWith('/issues/comments/77')) return { stdout: JSON.stringify(f.comment) };
      pages++;
      return { stdout: mode === 'corrupt' ? '{broken' : Array.from({ length: 100 }, () => JSON.stringify({ content: 'eyes', user: bot })).join('\n') };
    } });
    await assert.rejects(reader.observe(input), mode === 'full' ? /pagination limit/ : /JSON/);
    assert.equal(pages, mode === 'full' ? 100 : 1); await reader.stop();
  }
});

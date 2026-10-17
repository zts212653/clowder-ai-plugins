import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubPrIndexProvider } from './pr-index-provider.js';

test('actual transport uses bounded GET metadata pages and complete ordered review pagination', async () => {
  const calls: string[][] = [];
  const provider = new GitHubPrIndexProvider({ token: async () => 'isolated-pr-index', execFileAsync: async (file, args) => {
    assert.equal(file, 'gh'); calls.push(args); assert.ok(args.includes('GET')); assert.ok(!args.includes('--paginate'));
    const url = new URL(args[1]!); assert.equal(url.origin, 'https://api.github.com');
    const reviews = url.pathname.endsWith('/reviews'), page = Number(url.searchParams.get('page'));
    const count = reviews ? page === 1 ? 100 : 1 : 25;
    return { stdout: Array.from({length: count}, (_, i) => JSON.stringify({ id: (page - 1) * 100 + i })).join('\n') };
  } });
  assert.equal((await provider.page('owner/repo', 2, new AbortController().signal)).length, 25);
  const rows = [...await provider.reviewPage('owner/repo', 42, 1, new AbortController().signal), ...await provider.reviewPage('owner/repo', 42, 2, new AbortController().signal)];
  assert.equal(rows.length, 101); assert.deepEqual(rows.at(-1), {id:100}); assert.equal(calls.length, 3);
  assert.match(calls[0]![1]!, /sort=created&direction=asc&per_page=25&page=2/);
  assert.ok(!calls[0]!.at(-1)!.includes('body'));
});

test('review page errors and corrupt JSON propagate without hiding continuation', async () => {
  for (const mode of ['error','bad-json','oversized']) {
    let calls = 0;
    const provider = new GitHubPrIndexProvider({token: async () => `isolated-index-${mode}`, execFileAsync: async (_file,args) => {
      calls++; assert.match(args[1]!, /page=2$/);
      if (mode === 'error') throw new Error('page unavailable');
      return {stdout: mode === 'bad-json' ? '{bad' : Array.from({length:101}, () => '{}').join('\n')};
    }});
    await assert.rejects(provider.reviewPage('owner/repo',42,2,new AbortController().signal)); assert.equal(calls,1);
  }
});

test('secret wait is cancellable without starting a provider process', async () => {
  let calls = 0;
  const provider = new GitHubPrIndexProvider({token: () => new Promise(() => {}), execFileAsync: async () => { calls++; return {stdout:''}; }});
  const controller = new AbortController();
  const query = assert.rejects(provider.page('owner/repo', 1, controller.signal)); controller.abort(new Error('stopped'));
  await query; assert.equal(calls,0);
});

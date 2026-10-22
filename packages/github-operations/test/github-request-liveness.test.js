import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchPaginated } from '../src/business/infrastructure/github/fetch-paginated.js';

test('GitHub primary quota is shared by credential, preserves other credentials and resumes after reset', async () => {
  let calls = 0;
  const exec = async () => {
    calls++;
    throw Object.assign(new Error('API rate limit exceeded'), {
      stdout: 'HTTP/2.0 403 Forbidden\r\nx-ratelimit-remaining: 0\r\nx-ratelimit-reset: 4102444800\r\n\r\n{}',
    });
  };
  await assert.rejects(
    fetchPaginated('/repos/a/b/issues/1/comments', { ghToken: 'budget-token-a', execFileAsync: exec }),
    /rate|quota/i,
  );
  for (let i = 0; i < 10; i++)
    await assert.rejects(
      fetchPaginated(`/repos/a/b/issues/${i + 2}/comments`, { ghToken: 'budget-token-a', execFileAsync: exec }),
    );
  assert.equal(calls, 1, 'same exhausted credential must not spawn per object');
  const other = await fetchPaginated('/repos/a/b/issues/1/comments', {
    ghToken: 'budget-token-b',
    execFileAsync: async () => ({ stdout: '{"id":1}' }),
  });
  assert.equal(other.length, 1);
});
test('comment cursor uses its immutable creation time to avoid replaying the entire historical page set', async () => {
  const requests = [];
  const items = await fetchPaginated('/repos/a/b/issues/98/comments', {
    sinceId: 50000,
    ghToken: 'incremental-token',
    execFileAsync: async (_file, args) => {
      const endpoint = args[1];
      requests.push(endpoint);
      if (endpoint === '/repos/a/b/issues/comments/50000')
        return { stdout: '{"id":50000,"created_at":"2026-10-03T00:00:00Z"}' };
      assert(endpoint.includes('since='), 'list must start at the safe timestamp boundary');
      return {
        stdout: '{"id":50000,"created_at":"2026-10-03T00:00:00Z"}\n{"id":50001,"created_at":"2026-10-03T00:00:00Z"}',
      };
    },
  });
  assert.deepEqual(
    items.map((item) => item.id),
    [50001],
  );
  assert.equal(requests.length, 2);
});
test('an aborted page read prevents more historical subprocesses', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    fetchPaginated('/repos/a/b/pulls/1/reviews', {
      signal: controller.signal,
      execFileAsync: async () => {
        calls++;
        controller.abort(new Error('cancelled gate'));
        if (calls > 1) return { stdout: '' };
        return { stdout: Array.from({ length: 100 }, (_, i) => JSON.stringify({ id: i + 1 })).join('\n') };
      },
    }),
    /cancelled gate/,
  );
  assert.equal(calls, 1);
});
test('rate reset and secondary retry-after recover without token cross-contamination or concurrent retry storms', async () => {
  const { GitHubRequestBudget, GitHubRateLimitError } = await import('../src/business/infrastructure/github/request-budget.js');
  let now = 1000;
  const budget = new GitHubRequestBudget(() => now);
  let calls = 0;
  const execute = async () => {
    calls++;
    if (calls === 1)
      throw Object.assign(new Error('secondary rate limit'), {
        stderr: 'HTTP/2.0 429 Too Many Requests\nretry-after: 3\n\n',
      });
    return { stdout: 'HTTP/2.0 200 OK\nContent-Type: application/json\n\n{"ok":true}' };
  };
  const results = await Promise.allSettled(
    Array.from({ length: 50 }, () =>
      budget.execute(['api', '/user'], { ghToken: 'retry-fixture', execFileAsync: execute }),
    ),
  );
  assert.equal(calls, 1);
  assert(results.every((result) => result.status === 'rejected' && result.reason instanceof GitHubRateLimitError));
  now = 4001;
  assert.equal(
    (await budget.execute(['api', '/user'], { ghToken: 'retry-fixture', execFileAsync: execute })).stdout,
    '{"ok":true}',
  );
  assert.equal(calls, 2);
});
test('queued GitHub cancellation returns promptly without starting a subprocess or waiting for a predecessor', async () => {
  const { GitHubRequestBudget } = await import('../src/business/infrastructure/github/request-budget.js');
  const budget = new GitHubRequestBudget();
  let release;
  const pause = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const firstStarted = new Promise((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const execFileAsync = async () => {
    calls++;
    started();
    await pause;
    return { stdout: '{}' };
  };
  const first = budget.execute(['api', '/user'], { ghToken: 'queued-cancel', execFileAsync });
  await firstStarted;
  const controller = new AbortController();
  const second = budget.execute(['api', '/user'], {
    ghToken: 'queued-cancel',
    interactive: true,
    execFileAsync,
    signal: controller.signal,
  });
  controller.abort(new Error('queued request cancelled'));
  await assert.rejects(second, /queued request cancelled/);
  assert.equal(calls, 1);
  release();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, 'aborted queued work must never start later');
  await budget.execute(['api', '/user'], { ghToken: 'queued-cancel', execFileAsync });
  assert.equal(calls, 2, 'queue recovers after cancelled work drains');
});
test('request deadline includes time waiting behind another credential request', async () => {
  const { GitHubRequestBudget } = await import('../src/business/infrastructure/github/request-budget.js');
  const budget = new GitHubRequestBudget();
  let release;
  let started;
  const began = new Promise((resolve) => {
    started = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const execFileAsync = async () => {
    calls++;
    started();
    await blocked;
    return { stdout: '{}' };
  };
  const first = budget.execute(['api', '/user'], { ghToken: 'queued-deadline', execFileAsync });
  await began;
  // A referenced timer keeps this synthetic blocked transport alive while the
  // production AbortSignal timeout (deliberately unref'ed by Node) expires.
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(
      budget.execute(['api', '/user'], { ghToken: 'queued-deadline', execFileAsync, timeoutMs: 10, interactive: true }),
      /timeout|timed out/i,
    );
    assert.equal(calls, 1);
  } finally {
    clearTimeout(keepAlive);
    release();
    await first;
  }
});

test('interactive GitHub reads pass queued collection work without concurrent credential use or background starvation', async () => {
  const { GitHubRequestBudget } = await import('../src/business/infrastructure/github/request-budget.js');
  const budget = new GitHubRequestBudget();
  let release, entered;
  const running = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const order = []; let active = 0, maximum = 0;
  const execFileAsync = async (_file, args) => {
    maximum = Math.max(maximum, ++active); order.push(args[1]);
    if (args[1] === 'running') { entered(); await blocked; }
    active--; return { stdout: '{}' };
  };
  const options = { ghToken: 'foreground-admission-fixture', execFileAsync };
  const first = budget.execute(['api', 'running'], options); await running;
  const background = Array.from({ length: 6 }, (_, i) => budget.execute(['api', `poll-${i}`], options));
  const foreground = Array.from({ length: 9 }, (_, i) => budget.execute(['api', `native-${i}`], { ...options, interactive: true }));
  release(); await Promise.all([first, ...background, ...foreground]);
  assert.equal(order[1], 'native-0', 'a native baseline must not wait behind the complete scheduled backlog');
  assert.ok(order.indexOf('poll-0') <= 5, 'a stream of native calls must still admit a waiting collector within four requests');
  assert.deepEqual(order.filter(id => id.startsWith('native-')), Array.from({ length: 9 }, (_, i) => `native-${i}`));
  assert.deepEqual(order.filter(id => id.startsWith('poll-')), Array.from({ length: 6 }, (_, i) => `poll-${i}`));
  assert.equal(maximum, 1, 'priority never adds concurrency for the same credential');
});

test('interactive admission cannot bypass the shared queue capacity or credential quota', async () => {
  const { GitHubRequestBudget } = await import('../src/business/infrastructure/github/request-budget.js');
  const budget = new GitHubRequestBudget();
  let release, entered, calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const options = { ghToken: 'interactive-capacity-quota', execFileAsync: async () => {
    calls++; entered(); await blocked;
    throw Object.assign(new Error('secondary rate limit'), { stderr: 'HTTP/2.0 429\nretry-after: 60\n\n' });
  } };
  const requests = [budget.execute(['api', '/user'], options)]; await started;
  requests.push(...Array.from({ length: 63 }, () => budget.execute(['api', '/user'], options)));
  await assert.rejects(budget.execute(['api', '/user'], { ...options, interactive: true }), /capacity/);
  const settled = Promise.allSettled(requests);
  release(); assert.ok((await settled).every(result => result.status === 'rejected'));
  await assert.rejects(budget.execute(['api', '/user'], { ...options, interactive: true }), /quota/);
  assert.equal(calls, 1, 'queued and later native reads must honor the same quota fence');
});

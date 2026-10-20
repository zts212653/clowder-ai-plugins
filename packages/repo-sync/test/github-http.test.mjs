import assert from 'node:assert/strict';
import test from 'node:test';
import { runExecution, safeError } from '../src/execution.mjs';
import { api, graphql } from '../src/gh-api.mjs';

function isolated(t) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env))
    if (key.toUpperCase() === 'PATH' || ['GH_TOKEN', 'GITHUB_TOKEN'].includes(key)) delete process.env[key];
  process.env.PATH = '';
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
}
test('native GitHub REST pagination works without gh or PATH and follows only same-origin read requests', async (t) => {
  isolated(t);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json([{ number: calls.length }], {
      headers:
        calls.length === 1
          ? { link: '<https://api.github.com/repos/demo/core/pulls?per_page=1&page=2>; rel="next"' }
          : {},
    });
  });
  assert.deepEqual(await api('repos/demo/core/pulls?per_page=1', true), [{ number: 1 }, { number: 2 }]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, undefined);
});
test('native GraphQL preserves complete paged closure evidence without launching gh', async (t) => {
  isolated(t);
  process.env.GH_TOKEN = 'SYNTHETIC_GITHUB_READ_TOKEN';
  const cursors = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'https://api.github.com/graphql');
    assert.equal(options.headers.Authorization, 'Bearer SYNTHETIC_GITHUB_READ_TOKEN');
    const input = JSON.parse(options.body);
    cursors.push(input.variables.endCursor);
    return Response.json({
      data: {
        repository: {
          pullRequest: {
            closingIssuesReferences: {
              nodes: [{ id: `issue-${cursors.length}` }],
              pageInfo: { hasNextPage: cursors.length === 1, endCursor: 'cursor-1' },
            },
          },
        },
      },
    });
  });
  const pages = await graphql(
    'query($endCursor:String){repository{pullRequest{closingIssuesReferences{pageInfo{hasNextPage endCursor}}}}}',
    {},
  );
  assert.equal(pages.length, 2);
  assert.deepEqual(cursors, [undefined, 'cursor-1']);
});
test('auth, rate limits and API failures are distinct and never return raw server messages', async (t) => {
  isolated(t);
  for (const [status, headers, expected] of [
    [401, {}, 'GITHUB_AUTH_REQUIRED'],
    [403, { 'x-ratelimit-remaining': '0' }, 'GITHUB_RATE_LIMITED'],
    [429, { 'retry-after': '60' }, 'GITHUB_RATE_LIMITED'],
    [403, {}, 'GITHUB_ACCESS_DENIED'],
    [404, {}, 'GITHUB_REPOSITORY_UNAVAILABLE'],
    [503, {}, 'GITHUB_API_UNAVAILABLE'],
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', async () =>
      Response.json({ message: 'PRIVATE_SERVER_VALUE' }, { status, headers }),
    );
    await assert.rejects(
      () => api('repos/demo/core'),
      (error) => {
        assert.equal(error.code, expected);
        assert.doesNotMatch(JSON.stringify(safeError(error)), /PRIVATE_SERVER_VALUE/);
        return true;
      },
    );
    mock.mock.restore();
  }
});
test('host changes, repeated pagination, invalid JSON and missing GraphQL auth fail closed', async (t) => {
  isolated(t);
  let calls = 0;
  const mock = t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json([], { headers: { link: '<https://private.example/steal>; rel="next"' } });
  });
  await assert.rejects(() => api('repos/demo/core/issues', true), { code: 'GITHUB_RESPONSE_INVALID' });
  assert.equal(calls, 1);
  mock.mock.restore();
  const invalid = t.mock.method(globalThis, 'fetch', async () => new Response('private invalid JSON'));
  await assert.rejects(() => api('repos/demo/core'), { code: 'GITHUB_RESPONSE_INVALID' });
  invalid.mock.restore();
  const repeated = t.mock.method(globalThis, 'fetch', async () =>
    Response.json([], { headers: { link: '<https://api.github.com/repos/demo/core/issues>; rel="next"' } }),
  );
  await assert.rejects(() => api('repos/demo/core/issues', true), { code: 'GITHUB_RESPONSE_INVALID' });
  repeated.mock.restore();
  await assert.rejects(() => graphql('query{viewer{login}}', {}), { code: 'GITHUB_AUTH_REQUIRED' });
});
test('partial or malformed GraphQL results, repeated cursors and rate limits never masquerade as complete evidence', async (t) => {
  isolated(t);
  process.env.GH_TOKEN = 'SYNTHETIC_GITHUB_READ_TOKEN';
  const query = 'query($endCursor:String){node{timelineItems{nodes{id} pageInfo{hasNextPage endCursor}}}}';
  for (const [value, code] of [
    [null, 'GITHUB_RESPONSE_INVALID'],
    [{ errors: [{ type: 'RATE_LIMITED' }] }, 'GITHUB_RATE_LIMITED'],
    [{ data: {}, errors: [{ message: 'PRIVATE_VALUE' }] }, 'METADATA_INCOMPLETE'],
    [
      { data: { node: { timelineItems: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'repeated' } } } } },
      'METADATA_INCOMPLETE',
    ],
  ]) {
    const mocked = t.mock.method(globalThis, 'fetch', async () => Response.json(value));
    await assert.rejects(
      () => graphql(query, {}),
      (error) => {
        assert.equal(error.code, code);
        assert.doesNotMatch(JSON.stringify(safeError(error)), /PRIVATE_VALUE/);
        return true;
      },
    );
    mocked.mock.restore();
  }
});
test('cancelling a native GitHub request aborts that request rather than becoming a network error', async (t) => {
  isolated(t);
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++;
    return new Promise((_done, reject) =>
      options.signal.addEventListener('abort', () => reject(new DOMException('private cause', 'AbortError')), {
        once: true,
      }),
    );
  });
  const running = runExecution({ signal: controller.signal }, () => api('repos/demo/core'));
  controller.abort();
  await assert.rejects(running, { code: 'OPERATION_CANCELLED' });
  assert.equal(calls, 1);
});

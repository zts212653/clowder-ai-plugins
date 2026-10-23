import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGhIssueSourceReader, decodeGhSourceResponse } from '../../src/source/GhIssueSourceReader.js';

const end = { hasNextPage: false, endCursor: null };
const raw = (number: number) => ({
  id: `i${number}`,
  number,
  title: 'Issue',
  url: 'https://github.com/test/repo/issues/1',
  state: 'OPEN',
  updatedAt: '2026-10-12T00:00:00Z',
  author: { login: 'a' },
  labels: { nodes: [], pageInfo: end },
  comments: { nodes: [], totalCount: 0, pageInfo: end },
});
test('a missing focused issue does not discard readable inventory; other partial GraphQL errors fail closed', async () => {
  const data = { repository: { focus: null, issues: { nodes: [raw(2)], pageInfo: end } } };
  const payload = { data, errors: [{ path: ['repository', 'focus'], message: 'Could not resolve issue' }] };
  const reader = createGhIssueSourceReader(async () => decodeGhSourceResponse(JSON.stringify(payload)));
  const result = await reader('test/repo', undefined, 1);
  assert.equal(result.issues[0].number, 2);
  assert.equal(result.failures[0].issueNumber, 1);
  assert.equal(result.complete, false);
  const partialFocus = decodeGhSourceResponse(
    JSON.stringify({
      data: { repository: { ...data.repository, focus: raw(1) } },
      errors: [{ path: ['repository', 'focus', 'body'], message: 'incomplete body' }],
    }),
  );
  assert.equal(partialFocus.repository?.focus, null);
  assert.throws(() =>
    decodeGhSourceResponse(
      JSON.stringify({ ...payload, errors: [{ path: ['repository', 'issues'], message: 'incomplete' }] }),
    ),
  );
});
test('query adapter pages issues and comments; incomplete comment pages never replace old subjects', async () => {
  let calls = 0;
  const reader = createGhIssueSourceReader(async (query) => {
    calls++;
    assert.ok(!query.includes('mutation'));
    if (query.includes('node(id:')) throw new Error('network down');
    if (calls === 1)
      return {
        repository: {
          issues: {
            nodes: [
              { ...raw(1), comments: { nodes: [], totalCount: 101, pageInfo: { hasNextPage: true, endCursor: 'c' } } },
              raw(2),
            ],
            pageInfo: { hasNextPage: true, endCursor: 'p2' },
          },
        },
      };
    return { repository: { issues: { nodes: [raw(3)], pageInfo: end } } };
  });
  const result = await reader('test/repo');
  assert.deepEqual(
    result.issues.map((i) => i.number),
    [2, 3],
  );
  assert.equal(result.failures[0].issueNumber, 1);
  assert.equal(result.complete, false);
  assert.equal(calls, 3);
});
test('rate limit stops further pagination and carries a retry bound without leaking stderr', async () => {
  let calls = 0;
  const reader = createGhIssueSourceReader(async () => {
    calls++;
    return {
      repository: { issues: { nodes: [raw(1)], pageInfo: { hasNextPage: true, endCursor: 'p2' } } },
      rateLimit: { remaining: 0, resetAt: '2026-10-12T01:00:00Z' },
    };
  });
  const result = await reader('test/repo');
  assert.equal(calls, 1);
  assert.equal(result.complete, false);
  assert.equal(result.retryAt, '2026-10-12T01:00:00Z');
  assert.equal(result.failures[0].kind, 'rate_limit');
});

test('the active issue is reconciled even when comment edits did not advance its issue timestamp', async () => {
  const reader = createGhIssueSourceReader(async (query) => {
    assert.match(query, /focus:issue\(number:1\)/);
    return { repository: { focus: raw(1), issues: { nodes: [raw(2)], pageInfo: end } } };
  });
  const result = await reader('test/repo', '2026-10-12T01:00:00Z', 1);
  assert.deepEqual(
    result.issues.map((i) => i.number),
    [1],
  );
  assert.equal(result.complete, true);
});

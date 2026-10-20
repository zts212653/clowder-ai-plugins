import assert from 'node:assert/strict';
import test from 'node:test';
import { collectIssues, issueReferences } from '../src/github-issues.mjs';

const pageInfo = { hasNextPage: false, endCursor: null };
const sourceIssue = {
  id: 'issue-71', node_id: 'issue-71', number: 71, title: 'Real issue', body: 'Refs only',
  url: 'https://github.com/demo/core/issues/71', html_url: 'https://github.com/demo/core/issues/71',
  repository: { nameWithOwner: 'demo/core' },
};
function fixture(t, { status = 404, authoritative = false, events = [], issueNumber = 71 } = {}) {
  const saved = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'SYNTHETIC_ISSUE_REFERENCE_TOKEN';
  t.after(() => {
    if (saved === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = saved;
  });
  const calls = [], issue = { ...sourceIssue, number: issueNumber };
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    if (path === '/graphql') {
      const { query } = JSON.parse(options.body);
      return Response.json({ data: query.includes('closingIssuesReferences')
        ? { repository: { pullRequest: { closingIssuesReferences: { nodes: authoritative ? [issue] : [], pageInfo } } } }
        : { node: { timelineItems: { nodes: events, pageInfo } } } });
    }
    if (path.endsWith('/issues/71')) return Response.json(issue);
    if (path.endsWith('/issues/72')) return Response.json({ pull_request: {} });
    return Response.json({ message: 'PRIVATE_RESPONSE' }, { status });
  });
  return calls;
}
const pr = { number: 1, node_id: 'pr-1', body: 'Refs #71' };

test('priority item numbers are not mistaken for Issue references', () => {
  assert.deepEqual(issueReferences([
    'P1 #1', 'Priority P2: #28', 'priority: P3 - #44', '[P1] #19',
  ], 'demo/core'), []);
  assert.deepEqual(issueReferences(['P1 #1, but Refs #28 and #35', 'Refs #1', '#28'], 'demo/core'), [
    { repo: 'demo/core', number: 28 },
    { repo: 'demo/core', number: 35 },
    { repo: 'demo/core', number: 1 },
  ]);
});

test('priority labels do not trigger Issue API lookups during collection', async (t) => {
  const calls = fixture(t);
  const notes = [];
  const issues = await collectIssues('demo/core', null, [], ['P1 #1', 'Priority P2: #28'], notes);
  assert.deepEqual(issues, []);
  assert.deepEqual(notes, []);
  assert.deepEqual(calls, []);
});

test('unresolved text references do not block valid Issues and retain an explicit diagnostic', async (t) => {
  fixture(t);
  const notes = [];
  const issues = await collectIssues('demo/core', pr, ['landed'], [
    'Ports Cat Café #4165/#4167; also #72; duplicate #4165',
  ], notes);
  assert.deepEqual(issues.map((item) => [item.number, item.relation]), [[71, 'related']]);
  assert.deepEqual(notes.map((item) => [item.number, item.status]), [[4165, 'unresolved'], [4167, 'unresolved']]);
  assert.ok(notes.every((item) => item.repo === 'demo/core' && item.url.startsWith('https://github.com/')));
  assert.doesNotMatch(JSON.stringify(notes), /PRIVATE_RESPONSE/);
});

test('project-name prose followed by slash-separated foreign Issue numbers is parsed as unresolved candidates', async (t) => {
  fixture(t);
  const notes = [];
  await collectIssues('demo/core', null, [], ['This ports Cat Café #4165/#4167 repair'], notes);
  assert.deepEqual(notes.map((item) => item.number), [4165, 4167]);
});

test('authentication, permission, rate limit and server failures still stop text reference resolution', async (t) => {
  for (const [status, code] of [[401, 'GITHUB_AUTH_REQUIRED'], [403, 'GITHUB_ACCESS_DENIED'],
    [429, 'GITHUB_RATE_LIMITED'], [503, 'GITHUB_API_UNAVAILABLE']]) {
    await t.test(String(status), async (child) => {
      fixture(child, { status });
      const notes = [];
      await assert.rejects(() => collectIssues('demo/core', null, [], ['Refs #4165'], notes), { code });
      assert.deepEqual(notes, []);
    });
  }
});

test('a missing authoritative closing reference is never discarded as a text typo', async (t) => {
  fixture(t, { authoritative: true, issueNumber: 4165 });
  await assert.rejects(() => collectIssues('demo/core', { ...pr, body: '' }, [], []), {
    code: 'GITHUB_REPOSITORY_UNAVAILABLE',
  });
});

test('closing evidence is preserved and ordinary references cannot acquire closing semantics', async (t) => {
  const calls = fixture(t, { authoritative: true, events: [{ id: 'closed-1', closer: { id: 'pr-1' } }] });
  const issues = await collectIssues('demo/core', pr, ['landed'], ['Refs #71']);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].relation, 'closes');
  assert.deepEqual(issues[0].evidence.map((event) => event.id), ['closed-1']);
  assert.equal(calls.filter((path) => path.endsWith('/issues/71')).length, 1, 'known association must not be fetched as a text candidate');
});

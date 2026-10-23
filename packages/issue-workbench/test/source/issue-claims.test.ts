import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGhIssueSourceReader } from '../../src/source/GhIssueSourceReader.js';
import { issueSourceContent, issueReviewContent } from '../../src/model/issue-source.js';
import { IssueSourceService } from '../../src/source/IssueSourceService.js';

const end = { hasNextPage: false, endCursor: null };
const raw = (logins: string[]) => ({ id: 'I_1', number: 1, title: 'Issue', body: 'Body', state: 'OPEN',
  url: 'https://github.com/test/repo/issues/1', updatedAt: '2026-10-23T00:00:00Z', author: { login: 'reporter' },
  labels: { nodes: [], pageInfo: end }, assignees: { nodes: logins.map(login => ({ login })), pageInfo: end },
  comments: { nodes: [], totalCount: 0, pageInfo: end } });
for (const scope of ['catalog', 'detail'] as const) test(`${scope} reads real assignees including an explicitly unclaimed issue`, async () => {
  for (const logins of [[], ['alice', 'bob']]) {
    const read = createGhIssueSourceReader(async query => {
      assert.match(query, /assignees\(first:100\)/);
      return { repository: { focus: raw(logins), issues: { nodes: [raw(logins)], pageInfo: end } } };
    });
    const result = await read('test/repo', undefined, 1, scope);
    assert.equal(result.complete, true);
    assert.deepEqual(result.issues[0].assignees, logins);
    if (scope === 'catalog') assert.equal(result.issues[0].body, undefined);
  }
});
test('incomplete assignees never become an unclaimed issue or a partial owner list', async () => {
  const issue = { ...raw(['alice']), assignees: { nodes: [{ login: 'alice' }], pageInfo: { ...end, hasNextPage: true } } };
  const result = await createGhIssueSourceReader(async () => ({ repository: { issues: { nodes: [issue], pageInfo: end } } }))('test/repo');
  assert.equal(result.complete, false);
  assert.deepEqual(result.issues, []);
});
test('claim changes update source metadata without invalidating reviewed issue prose', () => {
  const fact = { ...raw([]), labels: [], assignees: [], author: 'reporter', comments: [] };
  const claimed = { ...fact, assignees: ['alice'] };
  assert.notEqual(issueSourceContent(fact), issueSourceContent(claimed));
  assert.equal(issueReviewContent(fact), issueReviewContent(claimed));
});
test('refresh backfills legacy ownership even when issue timestamps have not changed', async () => {
  const fact = { ...raw([]), labels: [], author: 'reporter', comments: [], assignees: undefined };
  const now = Date.parse('2026-10-23T01:00:00Z');
  let snapshot = { repo: 'test/repo', revision: 1, fetchedAt: new Date(now).toISOString(), lastFullAt: new Date(now).toISOString(),
    lastCompleteAt: new Date(now).toISOString(), issues: [fact], failures: [], summary: { added: 0, changed: 0, closed: 0, reopened: 0 } } as any;
  const service = new IssueSourceService({ read: async () => snapshot, readDetail: async () => null, write: async value => { snapshot = value; } },
    async (_repo, since) => {
      assert.equal(since, undefined);
      return { issues: [{ ...fact, assignees: ['alice'] }], complete: true, failures: [] };
    }, () => now);
  const result = await service.refresh('test/repo');
  assert.deepEqual(result.issues[0].assignees, ['alice']);
});

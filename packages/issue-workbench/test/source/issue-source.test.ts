import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IssueSourceFact, IssueSourceSnapshot } from '../../src/model/issue-source.js';
import { IssueSourceService } from '../../src/source/IssueSourceService.js';

const fact = (number: number, state = 'OPEN'): IssueSourceFact => ({
  number,
  state,
  title: `Issue ${number}`,
  url: `https://github.com/test/repo/issues/${number}`,
  labels: [],
  updatedAt: '2026-10-10T00:00:00Z',
  body: 'body',
  commentCount: 1,
  comments: [
    {
      id: 'c1',
      author: 'a',
      body: 'old',
      createdAt: '2026-10-10T00:00:00Z',
      updatedAt: '2026-10-10T00:00:00Z',
      lastEditedAt: null,
      url: 'https://github.com/test/repo/issues/1#c1',
    },
  ],
});
function fixture() {
  let value: IssueSourceSnapshot = {
    repo: 'test/repo',
    revision: 1,
    fetchedAt: '2026-10-10T00:00:00Z',
    lastCompleteAt: '2026-10-10T00:00:00Z',
    issues: [fact(1), fact(2)],
    failures: [],
    summary: { added: 0, changed: 0, closed: 0, reopened: 0 },
  };
  return {
    read: async () => value,
    readDetail: async (_repo: string, number: number) => value.issues.find((i) => i.number === number) ?? null,
    write: async (next: IssueSourceSnapshot) => {
      value = next;
    },
  };
}
test('refresh merges source changes and retains absent closed/local-history subjects', async () => {
  const store = fixture();
  const changed = fact(1, 'CLOSED');
  changed.comments![0].body = 'edited without a count change';
  const service = new IssueSourceService(store, async () => ({
    issues: [changed, fact(3)],
    failures: [],
    complete: true,
  }));
  const result = await service.refresh('test/repo');
  assert.equal(result.issues.length, 3);
  assert.equal(result.issues.find((i) => i.number === 2)?.unavailable, true);
  assert.equal(result.issues.find((i) => i.number === 1)!.comments![0].body, 'edited without a count change');
  assert.deepEqual(result.summary, { added: 1, changed: 2, closed: 1, reopened: 0 });
});
test('partial reads preserve last complete time and failed subjects', async () => {
  const store = fixture();
  const service = new IssueSourceService(store, async () => ({
    issues: [fact(3)],
    failures: [{ issueNumber: 1, kind: 'incomplete', message: 'comments incomplete' }],
    complete: false,
  }));
  const result = await service.refresh('test/repo');
  assert.equal(result.lastCompleteAt, '2026-10-10T00:00:00Z');
  assert.equal(result.failures.length, 1);
  assert.equal(result.issues.find((i) => i.number === 1)!.comments![0].body, 'old');
});
test('concurrent refresh requests share one source read; older responses cannot overwrite a later refresh', async () => {
  const store = fixture();
  let calls = 0;
  const service = new IssueSourceService(store, async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return { issues: [], failures: [], complete: true };
  });
  const [a, b] = await Promise.all([service.refresh('test/repo'), service.refresh('test/repo')]);
  assert.equal(calls, 1);
  assert.equal(a.revision, b.revision);
});

test('render-only GitHub HTML identifiers are not reported as source edits', async () => {
  const rendered = fact(1);
  rendered.bodyHTML = '<section data-identity="random-per-request">body</section>';
  rendered.comments![0].bodyHTML = '<p data-identity="another-random-id">old</p>';
  const service = new IssueSourceService(fixture(), async () => ({
    issues: [rendered, fact(2)],
    failures: [],
    complete: true,
  }));
  const result = await service.refresh('test/repo');
  assert.equal(result.summary.changed, 0);
});

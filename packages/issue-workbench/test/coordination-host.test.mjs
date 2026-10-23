import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { githubPreviewBinding } from '../dist/coordination-host.mjs';

test('public READ Host cold-loads, persists across restart and pins comment pages without a second server', async t => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'issue-public-host-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const end = { hasNextPage: false, endCursor: null };
  let calls = 0, labels = [];
  const query = async (document, variables) => {
    calls++;
    assert.ok(document.trimStart().startsWith('query('));
    assert.equal(variables.owner, 'zts212653'); assert.equal(variables.name, 'clowder-ai');
    const fact = { id: 'test-88', number: 88, title: 'Public source', state: 'OPEN',
      updatedAt: new Date().toISOString(), url: 'https://github.com/zts212653/clowder-ai/issues/88',
      author: { login: 'tester' }, body: 'test body',
      labels: { nodes: labels.map(name => ({ name })), pageInfo: end },
      comments: { nodes: Array.from({ length: 30 }, (_, n) => ({ id: `comment-${n}`, body: `reply ${n}`, author: null, createdAt: '2026-10-20T00:00:00Z' })), totalCount: 30, pageInfo: end } };
    return { repository: { issues: { nodes: [fact], pageInfo: end }, ...(document.includes('focus:issue') ? { focus: fact } : {}) } };
  };
  const host = githubPreviewBinding({ dataRoot, query });
  const first = await host.catalog(false);
  assert.equal(first.issues.length, 1); assert.equal(calls, 1);
  const restarted = githubPreviewBinding({ dataRoot, query });
  await restarted.catalog(false); assert.equal(calls, 1, 'cache survives constructing a new Host');
  labels = ['feature:F128'];
  assert.deepEqual((await restarted.catalog(true)).issues[0].labels, labels);
  const ref = { sourceId: restarted.profile.id, issueId: 'test-88', number: 88 };
  const detail = await restarted.detail(ref);
  assert.equal(detail.fact.body, 'test body'); assert.equal(detail.fact.comments.length, 25);
  assert.equal(detail.nextOffset, 25);
  const atDetail = calls;
  const next = await restarted.detail(ref, 25, detail.fact.contentVersion);
  assert.equal(next.fact.comments.length, 5); assert.equal(next.nextOffset, null);
  assert.equal(calls, atDetail, 'next page reads the pinned local observation');
  await assert.rejects(restarted.detail(ref, 25), /Invalid detail page/);
  assert.throws(() => githubPreviewBinding(), /isolated dataRoot/);
});

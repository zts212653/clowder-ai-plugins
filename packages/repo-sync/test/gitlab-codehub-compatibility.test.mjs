import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { gitlabApi } from '../src/gitlab-api.mjs';
import { invokeIssue, verifyIssue } from '../src/issue-adapter.mjs';
import { gitlabPlatform } from './gitlab-fixture.mjs';

async function pages(t, responses) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push(url);
    const page = responses[Number(url.searchParams.get('page')) - 1];
    res.setHeader('Content-Type', 'application/json');
    if (page.next !== undefined) res.setHeader('X-Next-Page', page.next);
    res.end(JSON.stringify(page.value));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  process.env.REPO_SYNC_LIST_TEST_TOKEN = 'synthetic-list-token';
  const config = {
    issues: {
      apiUrl: `http://127.0.0.1:${server.address().port}/api/v4`,
      projectId: 'team/core',
      tokenEnv: 'REPO_SYNC_LIST_TEST_TOKEN',
    },
  };
  return { api: gitlabApi(config), requests };
}
const envelope = (issues) => ({ opened: issues.length, closed: 0, all: issues.length, issues });

test('CodeHub envelopes follow x-next-page while ordinary GitLab lists remain supported', async (t) => {
  for (const wrap of [envelope, (items) => items]) {
    const p = await pages(t, [
      { value: wrap([{ iid: 1 }]), next: '2' },
      { value: wrap([{ iid: 2 }]), next: '' },
    ]);
    assert.deepEqual(await p.api.list('issues?scope=all'), [{ iid: 1 }, { iid: 2 }]);
    assert.deepEqual(
      p.requests.map((r) => r.searchParams.get('page')),
      ['1', '2'],
    );
    assert.ok(p.requests.every((r) => r.searchParams.get('scope') === 'all'));
  }
});

test('an enveloped full page without pagination proof is rejected instead of hiding later Issue matches', async (t) => {
  const p = await pages(t, [{ value: envelope(Array.from({ length: 100 }, (_, iid) => ({ iid }))) }]);
  await assert.rejects(() => p.api.list('issues'), { code: 'ISSUE_RESPONSE_INVALID' });
});

test('enveloped pages cannot loop or truncate malformed replies, and MR lists cannot adopt Issue envelopes', async (t) => {
  for (const next of ['1', '0', '3', '9007199254740993', 'bogus']) {
    const p = await pages(t, [{ value: envelope([]), next }]);
    await assert.rejects(() => p.api.list('issues'), { code: 'ISSUE_RESPONSE_INVALID' });
  }
  for (const value of [{ issues: {} }, {}, null, { items: [] }, [null]]) {
    const p = await pages(t, [{ value, next: '' }]);
    await assert.rejects(() => p.api.list('issues'), { code: 'ISSUE_RESPONSE_INVALID' });
  }
  const p = await pages(t, [{ value: envelope([]), next: '' }]);
  await assert.rejects(() => p.api.list('merge_requests?state=all'), { code: 'ISSUE_RESPONSE_INVALID' });
});

test('CodeHub envelope lookup preserves duplicate detection and exact Issue state readback', async (t) => {
  const p = await gitlabPlatform({ envelope: true });
  t.after(p.close);
  assert.equal(await invokeIssue(p.config, { ...p.request, operation: 'find' }), null);
  const issue = await invokeIssue(p.config, { ...p.request, operation: 'create' });
  const found = await invokeIssue(p.config, { ...p.request, operation: 'find' });
  assert.deepEqual(verifyIssue(p.config, p.request, found), verifyIssue(p.config, p.request, issue));
  for (const desiredState of ['closed', 'open']) {
    const result = await invokeIssue(p.config, {
      ...p.request,
      internalId: issue.internalId,
      operation: 'update',
      desiredState,
    });
    assert.equal(result.state, desiredState);
  }
  p.duplicate();
  await assert.rejects(() => invokeIssue(p.config, { ...p.request, operation: 'find' }), { code: 'ISSUE_DUPLICATED' });
});

async function linkFixture(t, options = {}) {
  const p = await gitlabPlatform({ legacy: true, relatedUnsupported: true, ...options });
  t.after(p.close);
  const issue = await invokeIssue(p.config, { ...p.request, operation: 'create' });
  return {
    ...p,
    link: {
      ...p.request,
      internalId: issue.internalId,
      pr: {
        url: 'https://internal.example/team/core/merge_requests/2',
        head: 'head',
        branch: 'sync/key',
        targetBranch: 'main',
      },
    },
  };
}

test('CodeHub link/read proves exact MR description and candidate without the unsupported related endpoint', async (t) => {
  const p = await linkFixture(t);
  const before = await invokeIssue(p.config, { ...p.link, operation: 'read' });
  assert.equal(before.links.length, 0);
  const linked = await invokeIssue(p.config, { ...p.link, operation: 'link' });
  assert.deepEqual(linked.links, [p.link.pr]);
  const writes = p.writes();
  assert.deepEqual((await invokeIssue(p.config, { ...p.link, operation: 'read' })).links, [p.link.pr]);
  await invokeIssue(p.config, { ...p.link, operation: 'link' });
  assert.equal(p.writes(), writes);
  assert.equal(
    p.requests.some((r) => r.path.endsWith('/related_merge_requests')),
    false,
  );
  p.mismatch();
  await assert.rejects(() => invokeIssue(p.config, { ...p.link, operation: 'link' }), { code: 'ISSUE_PR_CONFLICT' });
  assert.equal(p.writes(), writes);
});

test('link marker alone, wrong Issue reference or ignored update never proves a link', async (t) => {
  const p = await linkFixture(t, { ignoreLinks: true });
  for (const description of [
    '[repo-sync-link:key:2]',
    'Related to #70\n[repo-sync-link:key:2]',
    'Related to #7',
    'Unrelated to #7\n[repo-sync-link:key:2]',
  ]) {
    p.description(description);
    assert.equal((await invokeIssue(p.config, { ...p.link, operation: 'read' })).links.length, 0);
    assert.equal((await invokeIssue(p.config, { ...p.link, operation: 'link' })).links.length, 0);
  }
  p.denied();
  await assert.rejects(() => invokeIssue(p.config, { ...p.link, operation: 'read' }), { code: 'ISSUE_API_REJECTED' });
});

test('existing marker with missing relation is repaired once without duplicating the marker or prior description', async (t) => {
  const p = await linkFixture(t);
  p.description('Original text\n[repo-sync-link:key:2]');
  const writes = p.writes();
  assert.equal((await invokeIssue(p.config, { ...p.link, operation: 'link' })).links.length, 1);
  assert.equal(p.writes(), writes + 1);
  await invokeIssue(p.config, { ...p.link, operation: 'link' });
  assert.equal(p.writes(), writes + 1);
  assert.equal(p.mrDescription(), 'Original text\n[repo-sync-link:key:2]\n\nRelated to #7');
});

test('a legitimate empty MR description can acquire its first association while malformed descriptions stop', async (t) => {
  const p = await linkFixture(t);
  p.description(null);
  assert.equal((await invokeIssue(p.config, { ...p.link, operation: 'read' })).links.length, 0);
  assert.equal((await invokeIssue(p.config, { ...p.link, operation: 'link' })).links.length, 1);
  assert.equal(p.mrDescription(), '\n\nRelated to #7\n[repo-sync-link:key:2]');
  const writes = p.writes();
  await invokeIssue(p.config, { ...p.link, operation: 'link' });
  assert.equal(p.writes(), writes);
  for (const description of [undefined, 7, { invalid: true }]) {
    p.description(description);
    await assert.rejects(() => invokeIssue(p.config, { ...p.link, operation: 'link' }), { code: 'ISSUE_PR_CONFLICT' });
    assert.equal(p.writes(), writes);
  }
});

test('invalid Issue ids and non-text provenance cannot become a mapping or a raw TypeError', async (t) => {
  const p = await gitlabPlatform();
  t.after(p.close);
  await invokeIssue(p.config, { ...p.request, operation: 'create' });
  for (const iid of [undefined, 0, -1, 'undefined', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    p.issue({ iid });
    await assert.rejects(() => invokeIssue(p.config, { ...p.request, operation: 'find' }), {
      code: 'ISSUE_RESPONSE_INVALID',
    });
  }
  p.issue({ iid: 7, description: { unrelated: true } });
  await assert.rejects(() => invokeIssue(p.config, { ...p.request, internalId: '7', operation: 'read' }), {
    code: 'ISSUE_IDENTITY_CONFLICT',
  });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { invokeIssue, validateIssueConfig, verifyIssue } from '../src/issue-adapter.mjs';
import { gitlabPlatform as platform } from './gitlab-fixture.mjs';

test('legacy CodeHub MR paths link and close the mapped Issue without accepting another repository', async () => {
  const p = await platform({ legacy: true });
  try {
    const issue = await invokeIssue(p.config, { ...p.request, operation: 'create' }),
      r = {
        ...p.request,
        internalId: issue.internalId,
        pr: {
          url: 'https://internal.example/team/core/merge_requests/2',
          head: 'head',
          branch: 'sync/key',
          targetBranch: 'main',
        },
      };
    const linked = await invokeIssue(p.config, { ...r, operation: 'link' });
    assert.equal(linked.links.length, 1);
    assert.equal((await invokeIssue(p.config, { ...r, operation: 'update', desiredState: 'closed' })).state, 'closed');
    await assert.rejects(
      () =>
        invokeIssue(p.config, {
          ...r,
          pr: { ...r.pr, url: 'https://internal.example/team/core-other/merge_requests/2' },
          operation: 'link',
        }),
      { code: 'ISSUE_PR_INVALID' },
    );
  } finally {
    await p.close();
  }
});

test('built-in GitLab adapter creates, links through real API readback and updates only the mapped Issue', async () => {
  const p = await platform();
  try {
    validateIssueConfig(p.config);
    assert.equal(await invokeIssue(p.config, { ...p.request, operation: 'find' }), null);
    let issue = await invokeIssue(p.config, { ...p.request, operation: 'create' });
    verifyIssue(p.config, p.request, issue);
    const r = {
      ...p.request,
      internalId: '7',
      pr: {
        url: 'https://internal.example/team/core/-/merge_requests/2',
        head: 'head',
        branch: 'sync/key',
        targetBranch: 'main',
      },
    };
    issue = await invokeIssue(p.config, { ...r, operation: 'link' });
    assert.equal(issue.links.length, 1);
    const writes = p.writes();
    await invokeIssue(p.config, { ...r, operation: 'link' });
    assert.equal(p.writes(), writes);
    issue = await invokeIssue(p.config, { ...r, operation: 'update', desiredState: 'closed' });
    assert.equal(issue.state, 'closed');
    p.mismatch();
    const before = p.writes();
    await assert.rejects(() => invokeIssue(p.config, { ...r, operation: 'link' }), { code: 'ISSUE_PR_CONFLICT' });
    assert.equal(p.writes(), before);
  } finally {
    await p.close();
  }
});
test('API errors and duplicated provenance fail closed without exposing private response', async () => {
  const p = await platform();
  try {
    await invokeIssue(p.config, { ...p.request, operation: 'create' });
    p.duplicate();
    await assert.rejects(() => invokeIssue(p.config, { ...p.request, operation: 'find' }), {
      code: 'ISSUE_DUPLICATED',
    });
    p.denied();
    await assert.rejects(
      () => invokeIssue(p.config, { ...p.request, operation: 'find' }),
      (e) => e.code === 'ISSUE_API_REJECTED' && !e.message.includes('PRIVATE_DO_NOT_RECORD'),
    );
  } finally {
    await p.close();
  }
});
test('Issue adapter configuration rejects credentials, untrusted redirects and missing variable names', () => {
  for (const apiUrl of [
    'http://internal.example/api/v4',
    'https://token@internal.example/api/v4',
    'https://internal.example/api/v4?token=secret',
  ])
    assert.throws(
      () =>
        validateIssueConfig({
          internalWebUrl: 'https://internal.example/core',
          issues: { mode: 'gitlab', apiUrl, projectId: '1', tokenEnv: 'TOKEN' },
        }),
      { code: 'INVALID_ISSUE_CONFIG' },
    );
});

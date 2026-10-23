import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './helpers/team-fixture.js';
import { issueVersion } from '../src/team/schema.js';
import { dispatchBody, GhTeamProvider } from '../src/team/github.js';

const signal = new AbortController().signal;
const owner = (actionId: string) => ({ kind: 'owner-operation' as const, userId: 'owner',
  pluginInstanceId: 'isolated-test', operationKey: 'teamWorkbench', actionId,
  requestId: 'owner-' + actionId, signal, assertCurrent: async () => {} });

test('READ member invites without assignee rights; restart receives once and reports without accepting automatically', async () => {
  const s = setup(); s.login('bob'); s.config.automaticAssignment = false;
  s.provider.canWrite = async () => { throw new Error('Invitation must not check assignee authority'); };
  s.provider.assignable = async () => { throw new Error('Invitation must not check assignability'); };
  const runtime = s.runtime();
  const input = { repo: 'fixture/repo', number: 1, requestId: 'invite', login: 'alice',
    delivery: 'invitation', sourceVersion: issueVersion(s.issues[0]) };
  const sent: any = await runtime.invokeOwner('assignIssue', input, owner('assignIssue'));
  assert.equal(sent.assignment.status, 'invited');
  assert.equal(sent.assignment.delivery, 'invitation');
  assert.equal(s.dispatches[0].delivery, 'invitation');
  assert.deepEqual(s.writes, []); assert.deepEqual(s.issues[0].assignees, []);
  await runtime.invokeOwner('assignIssue', input, owner('assignIssue'));
  assert.equal(s.dispatches.length, 1);
  s.login('alice');
  const rows: any = await runtime.invoke('receive', {}, s.caller());
  assert.equal(rows.length, 1); assert.equal(rows[0].delivery, 'invitation');
  assert.equal(rows[0].status, 'delivered'); assert.equal(rows[0].receipt, undefined);
  assert.match([...s.sends.values()][0].draft.payload.elements[0].payload.text, /邀请待接手/);
  await runtime.stop();
  const restarted = s.runtime(); await restarted.recover(); assert.equal(s.sends.size, 1);
  s.config.shareProgress = true;
  const report: any = await restarted.invoke('report', { id: rows[0].id, status: 'accepted',
    summary: 'I will investigate', evidenceUrls: [] }, s.caller('receiver', 'inbox'));
  assert.equal(report.receipt.commentId, 'receipt-comment');
  s.dispatches.splice(0);
  await restarted.recover();
  const inactive: any = await restarted.invoke('get', { id: rows[0].id }, s.caller());
  assert.equal(inactive.status, 'inactive'); assert.equal(s.sends.size, 2);
  await assert.rejects(restarted.invoke('report', { id: rows[0].id, status: 'working',
    summary: 'Still working', evidenceUrls: [] }, s.caller('receiver', 'inbox')), /changed/);
  await restarted.stop();
});

test('receiver discovers complete durable comment pages and excludes forged, edited, stale and wrong-target invitations', async () => {
  const raw = { node_id: 'I_1', number: 1, title: 'Fails to start', body: 'startup blocked', state: 'open',
    user: { login: 'alice' }, labels: [], assignees: [], html_url: 'https://github.com/fixture/repo/issues/1' };
  let comments: any[] = [], incomplete = false;
  const provider = new GhTeamProvider(async args => {
    if (args[3].includes('/comments?')) {
      assert.ok(!args.includes('--paginate'));
      assert.ok(args[3].includes('page=1'));
      return JSON.stringify(incomplete ? { message: 'page unavailable' } : comments);
    }
    assert.equal(args[3], 'repos/fixture/repo/issues/1');
    return JSON.stringify(raw);
  });
  const issue = await provider.issue('fixture/repo', 1, signal);
  const dispatch = { schema: 'issue-workbench.dispatch.v1' as const, id: 'a'.repeat(64), issueId: issue.id,
    assignee: 'alice', score: 9, reason: 'Blocked', sourceVersion: issueVersion(issue), delivery: 'invitation' as const };
  const comment = { id: 44, body: dispatchBody(dispatch), user: { login: 'bob' },
    issue_url: 'https://api.github.com/repos/fixture/repo/issues/1', created_at: '2026-10-21T01:00:00Z', updated_at: '2026-10-21T01:00:00Z' };
  comments = [comment, { ...comment, id: 45, user: { login: 'outsider' } },
    { ...comment, id: 46, updated_at: '2026-10-21T02:00:00Z' },
    { ...comment, id: 47, body: dispatchBody({ ...dispatch, assignee: 'mallory' }) },
    { ...comment, id: 48, body: dispatchBody({ ...dispatch, sourceVersion: '0'.repeat(64) }) },
    { ...comment, id: 49, issue_url: 'https://evil.test/repos/fixture/repo/issues/1' },
    { ...comment, id: 50, issue_url: 'not-a-url' }, { ...comment, id: 51, user: null },
    { ...comment, id: 52, user: { login: 'github-actions[bot]' } }];
  const received = await provider.invitations('fixture/repo', 'alice', ['bob'], signal);
  assert.equal(received.observations.length, 1); assert.equal(received.observations[0].assignmentId, 'invitation:44');
  assert.equal(received.observations[0].delivery, 'invitation');
  assert.equal(received.nextPage, null);
  assert.deepEqual((await provider.invitations('fixture/repo', 'alice', [], signal)).observations, []);
  incomplete = true;
  await assert.rejects(provider.invitations('fixture/repo', 'alice', ['bob'], signal), /array/);
});

test('invitation reports bind the actual commenter to a trusted invitation, not a fabricated assignment', async () => {
  const raw = { node_id: 'I_1', number: 1, title: 'Fails', body: 'blocked', state: 'open',
    user: { login: 'alice' }, labels: [], assignees: [], html_url: 'https://github.com/fixture/repo/issues/1' };
  let comments: any[] = [];
  const provider = new GhTeamProvider(async args => JSON.stringify(args[3].includes('/comments?') ? [comments]
    : args[3].includes('/timeline?') ? [[]] : raw));
  const issue = await provider.issue('fixture/repo', 1, signal);
  const dispatch = { schema: 'issue-workbench.dispatch.v1' as const, id: 'a'.repeat(64), issueId: issue.id,
    delivery: 'invitation' as const, assignee: 'alice', score: null, reason: 'Investigate', sourceVersion: issueVersion(issue) };
  const receipt = { schema: 'issue-workbench.receipt.v1', id: 'b'.repeat(64), issueId: issue.id,
    assignmentId: 'invitation:44', login: 'alice', status: 'accepted', summary: 'Taking it', evidenceUrls: [] };
  const report = { id: 45, user: { login: 'alice' }, created_at: '2026-10-21T02:00:00Z', updated_at: '2026-10-21T02:00:00Z',
    body: `<!-- issue-workbench.receipt.v1:${receipt.id} -->\n\`\`\`json\n${JSON.stringify(receipt)}\n\`\`\`` };
  comments = [{ id: 44, user: { login: 'bob' }, body: dispatchBody(dispatch),
    created_at: '2026-10-21T01:00:00Z', updated_at: '2026-10-21T01:00:00Z' }, report,
    { ...report, id: 46, user: { login: 'mallory' } }];
  assert.deepEqual(await provider.receipts(issue, signal, ['bob']), [receipt]);
  assert.deepEqual(await provider.receipts(issue, signal, []), []);
  comments[0].updated_at = '2026-10-21T03:00:00Z';
  assert.deepEqual(await provider.receipts(issue, signal, ['bob']), []);
});

test('automatic invitation uses reporter-first rules but policy, source and membership changes fence publication', async () => {
  const s = setup(); s.login('bob'); s.config.dispatchMode = 'invitation'; s.issues[0].author = 'alice';
  const runtime = s.runtime();
  const job: any = await runtime.invoke('analyze', { repo: 'fixture/repo', number: 1, requestId: 'auto-invite' }, s.caller());
  const analyzed: any = await runtime.invoke('submit', { id: job.id, analysis: s.analysis }, s.caller());
  assert.equal(analyzed.assignment.status, 'invited'); assert.equal(analyzed.assignment.basis, 'reporter');
  assert.deepEqual(s.writes, []);
  await runtime.recover(); assert.equal(s.dispatches.length, 1);
  s.issues[0].assignees = ['bob'];
  const blocked: any = await runtime.invokeOwner('assignIssue', { repo: 'fixture/repo', number: 1,
    login: 'alice', delivery: 'invitation', sourceVersion: issueVersion(s.issues[0]), requestId: 'different-owner' }, owner('assignIssue'));
  assert.equal(blocked.assignment.status, 'needs-decision'); assert.equal(s.dispatches.length, 1);
  await runtime.stop();
  const changed = setup(); changed.login('bob'); changed.config.dispatchMode = 'invitation';
  const second = changed.runtime();
  const pending: any = await second.invoke('analyze', { repo: 'fixture/repo', number: 1, requestId: 'policy-race' }, changed.caller());
  const cas = changed.context.storage.compareAndSet;
  changed.context.storage.compareAndSet = async (...args) => {
    const result = await cas(...args);
    if ((args[2] as any)?.assignment?.login) changed.config.dispatchMode = 'assignment';
    return result;
  };
  const stopped: any = await second.invoke('submit', { id: pending.id, analysis: changed.analysis }, changed.caller());
  assert.match(stopped.assignment.reason, /mode changed/);
  assert.deepEqual(changed.writes, []); assert.deepEqual(changed.dispatches, []);
  await second.stop();
});

test('failed scans and lost POST responses preserve inbox and require explicit publication retry', async () => {
  const s = setup(); s.login('bob');
  const publish = s.provider.publishDispatch;
  let attempts = 0;
  s.provider.publishDispatch = async (...args) => {
    attempts++; await publish(...args); throw new Error('response lost');
  };
  const runtime = s.runtime();
  const pending: any = await runtime.invokeOwner('assignIssue', { repo: 'fixture/repo', number: 1,
    requestId: 'lost-response', login: 'alice', delivery: 'invitation', sourceVersion: issueVersion(s.issues[0]) }, owner('assignIssue'));
  assert.equal(pending.assignment.commentAttempted, true); assert.equal(pending.assignment.commentId, undefined);
  await runtime.recover(); assert.equal(attempts, 1);
  const detail: any = await runtime.invokeOwner('get', { id: pending.id }, owner('get'));
  s.provider.publishDispatch = publish;
  const restored: any = await runtime.invokeOwner('republish', { id: pending.id, expectedRevision: detail.revision }, owner('republish'));
  assert.equal(restored.assignment.status, 'invited'); assert.deepEqual(s.writes, []);
  s.login('alice'); await runtime.invoke('receive', {}, s.caller());
  assert.equal(s.sends.size, 1);
  s.provider.invitations = async () => { throw new Error('incomplete page'); };
  await assert.rejects(runtime.invoke('receive', {}, s.caller()), /incomplete/);
  assert.equal(s.sends.size, 1, 'failed scan must not withdraw previously delivered invitations');
  await runtime.stop();
});

test('large repository catch-up commits bounded pages, resumes after restart and never withdraws work outside the discovery page', async () => {
  const s = setup(); s.login('alice'); s.config.automaticAssignment = false;
  const pages: number[] = [];
  const observation = { issue: structuredClone(s.issues[0]), assignmentId: 'invitation:44', delivery: 'invitation' as const,
    dispatch: { schema: 'issue-workbench.dispatch.v1' as const, id: 'a'.repeat(64), issueId: s.issues[0].id,
      delivery: 'invitation' as const, assignee: 'alice', score: 9, reason: 'Investigate', sourceVersion: issueVersion(s.issues[0]) } };
  let fail = false;
  s.provider.invitations = async (_repo, _login, _senders, _signal, page = 1, since) => {
    pages.push(page);
    if (fail) throw new Error('page failed');
    if (page >= 6) assert.equal(since, undefined, 'do not advance the timestamp before the full page sequence completes');
    return { observations: page === 1 ? [observation] : [], nextPage: page < 7 ? page + 1 : null,
      newestUpdatedAt: '2026-10-21T01:00:00.000Z' };
  };
  s.provider.invitation = async () => observation;
  const runtime = s.runtime(); await runtime.invoke('receive', {}, s.caller());
  assert.deepEqual(pages, [1, 2, 3, 4, 5]); assert.equal(s.sends.size, 1);
  await runtime.stop();
  const restart = s.runtime(); fail = true;
  await assert.rejects(restart.invoke('receive', {}, s.caller()), /page failed/);
  assert.equal(s.sends.size, 1);
  fail = false;
  await restart.invoke('receive', {}, s.caller());
  assert.deepEqual(pages, [1, 2, 3, 4, 5, 6, 6, 7]); assert.equal(s.sends.size, 1);
  const cursor = Object.entries(await s.context.storage.list()).find(([key]) => key.startsWith('issue-workbench.invitation-scan.'))![1].value as any;
  assert.equal(cursor.page, 1); assert.equal(cursor.since, '2026-10-21T00:59:59.000Z');
  await restart.stop();
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './helpers/team-fixture.js';

const request = (s: ReturnType<typeof setup>, runtime = s.runtime()) =>
  runtime.invoke('analyze', { repo: 'fixture/repo', number: 1, requestId: 'request-1' }, s.caller('requester'));

test('conversation analysis persists, routes by configured ownership and recovers without duplicate assignment', async () => {
  const s = setup(), r = s.runtime();
  const job = await request(s, r);
  assert.equal(job.status, 'delivered');
  assert.equal(s.sends.size, 1);
  const result = await r.invoke('submit', { id: job.id, analysis: s.analysis }, s.caller());
  assert.equal(result.status, 'analyzed');
  assert.deepEqual(s.writes, ['alice']);
  assert.equal(s.dispatches[0].score, 9);
  await s.runtime().recover();
  assert.deepEqual(s.writes, ['alice']);
  const stats = await r.invoke('statistics', {}, s.caller());
  assert.equal(stats.analyzed, 1);
  assert.equal(stats.feedback, 0);
  assert.equal(stats.acceptanceRate, null);
});

test('model result cannot replace Feature ownership, forge evidence, or reassign an existing owner', async () => {
  const s = setup(), r = s.runtime();
  s.issues[0].labels = ['feature:F123'];
  s.config.routingRules = JSON.stringify([{ login: 'alice', categories: [], features: ['F123'] }]);
  const job = await request(s, r);
  await assert.rejects(r.invoke('submit', { id: job.id, analysis: { ...s.analysis, evidence: 'invented source quote' } }, s.caller()), /evidence/i);
  s.issues[0].assignees = ['bob'];
  await r.invoke('submit', { id: job.id, analysis: { ...s.analysis, category: 'unrelated' } }, s.caller());
  assert.equal(s.writes.length, 0);
  const row = await r.invoke('get', { id: job.id }, s.caller());
  assert.deepEqual(row.features, ['F123']);
  assert.equal(row.assignment.status, 'needs-decision');
});

test('stale issue and foreign thread/cat cannot submit or trigger external writes', async () => {
  const s = setup(), r = s.runtime(), job = await request(s, r);
  await assert.rejects(r.invoke('submit', { id: job.id, analysis: s.analysis }, s.caller('receiver')), /target/i);
  await assert.rejects(r.invoke('submit', { id: job.id, analysis: s.analysis }, s.caller('analyst', 'other')), /target/i);
  s.issues[0].body += ' Changed circumstances.';
  await assert.rejects(r.invoke('submit', { id: job.id, analysis: s.analysis }, s.caller()), /changed|stale/i);
  assert.equal(s.writes.length, 0);
});

test('pending analysis survives Host failure; route unavailability never substitutes another cat', async () => {
  const s = setup(), r = s.runtime();
  s.routable(false);
  const job = await request(s, r);
  assert.equal(job.status, 'pending');
  assert.equal(s.sends.size, 0);
  s.routable(true); s.failSend(true);
  await s.runtime().recover();
  assert.equal(s.sends.size, 0);
  s.failSend(false);
  await s.runtime().recover();
  assert.equal(s.sends.size, 1);
  await s.runtime().recover();
  assert.equal(s.sends.size, 1);
});

test('first startup imports existing assignments, restart deduplicates, and reassignment has a new identity', async () => {
  const s = setup(); s.login('alice'); s.issues[0].assignees = ['alice'];
  await s.runtime().recover();
  assert.equal(s.sends.size, 1);
  await s.runtime().recover();
  assert.equal(s.sends.size, 1);
  s.epoch('assignment-2');
  await s.runtime().recover();
  assert.equal(s.sends.size, 3, 'new assignment plus a withdrawal notice for the previous assignment');
  await s.runtime().recover();
  assert.equal(s.sends.size, 3, 'both notices survive restart without duplication');
});

test('changed inbox target does not redirect a pending delivery; unauthorized caller has no effects', async () => {
  const s = setup(); s.login('alice'); s.issues[0].assignees = ['alice']; s.failSend(true);
  await s.runtime().recover();
  s.config.inboxThreadId = 'another-thread'; s.failSend(false);
  await s.runtime().recover();
  assert.equal(s.sends.size, 0);
  await assert.rejects(request({ ...s, caller: () => undefined as any }), /Host|caller|context/i);
  assert.equal(s.writes.length, 0);
});

test('feedback is counted once and statistics never call unreviewed output accepted', async () => {
  const s = setup(), r = s.runtime(), job = await request(s, r);
  await r.invoke('submit', { id: job.id, analysis: s.analysis }, s.caller());
  await r.invoke('feedback', { id: job.id, verdict: 'corrected', reason: 'Workaround discovered' }, s.caller('requester', 'analysis', 'feedback-source'));
  await r.invoke('feedback', { id: job.id, verdict: 'corrected', reason: 'Workaround discovered' }, s.caller('requester', 'analysis', 'feedback-source'));
  const stats = await r.invoke('statistics', {}, s.caller());
  assert.equal(stats.feedback, 1); assert.equal(stats.corrected, 1); assert.equal(stats.acceptanceRate, 0);
});

test('turning automatic assignment off during permission checks prevents the external write', async () => {
  const s = setup(), r = s.runtime(), job = await request(s, r);
  s.provider.assignable = async () => { s.config.automaticAssignment = false; return true; };
  await r.invoke('submit', { id: job.id, analysis: s.analysis }, s.caller());
  assert.equal(s.writes.length, 0);
});

test('receiver reports require the current assignment and explicit publication setting', async () => {
  const s = setup(); s.login('alice'); s.issues[0].assignees = ['alice'];
  const r = s.runtime(); await r.recover();
  const inbox = await r.invoke('receive', {}, s.caller('receiver', 'inbox')) as any[];
  const report = { id: inbox[0].id, status: 'accepted', summary: 'Taking this issue', evidenceUrls: [] };
  await assert.rejects(r.invoke('report', report, s.caller('receiver', 'inbox')), /sharing/i);
  s.config.shareProgress = true;
  await r.invoke('report', report, s.caller('receiver', 'inbox'));
  s.epoch('new-assignment');
  await assert.rejects(r.invoke('report', { ...report, status: 'working' }, s.caller('receiver', 'inbox')), /changed/i);
});

test('cat-authored messages cannot become owner feedback or inflate acceptance statistics', async () => {
  const s = setup(), r = s.runtime(), job = await request(s, r);
  await r.invoke('submit', { id: job.id, analysis: s.analysis }, s.caller());
  s.feedbackFromCat();
  await assert.rejects(r.invoke('feedback', { id: job.id, verdict: 'accepted', reason: 'I approve myself' }, s.caller('requester', 'analysis', 'cat-source')), /owner/i);
});

test('the original analysis request is not approval, and changing feedback retains its earlier judgment', async () => {
  const s = setup(), r = s.runtime(), job = await request(s, r);
  await r.invoke('submit', { id: job.id, analysis: s.analysis }, s.caller());
  const feedback = { id: job.id, verdict: 'accepted', reason: 'Confirmed from reproduction' };
  await assert.rejects(r.invoke('feedback', feedback, s.caller('requester')), /owner/i);
  await r.invoke('feedback', feedback, s.caller('requester', 'analysis', 'feedback-source'));
  await r.invoke('feedback', { ...feedback, verdict: 'corrected', reason: 'Scope is smaller' }, s.caller('requester', 'analysis', 'feedback-correction'));
  const row = await r.invoke('get', { id: job.id }, s.caller()) as any;
  assert.equal(row.feedbackHistory.length, 1);
  assert.equal(row.feedbackHistory[0].verdict, 'accepted');
  s.issues[0].assignees = ['bob'];
  const latest = await r.invoke('get', { id: job.id }, s.caller()) as any;
  assert.deepEqual(latest.currentIssue.assignees, ['bob']);
});

test('personal inbox orders higher priorities first and leaves unscored issues explicit', async () => {
  const s = setup(); s.login('alice'); s.issues[0].assignees = ['alice'];
  const observations = [5, null, 9].map((score, index) => {
    const issue = { ...s.issues[0], number: index + 1, id: `issue-${index + 1}` };
    return { issue, assignmentId: `event-${index}`, dispatch: score === null ? null : {
      schema: 'issue-workbench.dispatch.v1' as const, id: String(index).repeat(64), issueId: issue.id,
      assignee: 'alice', score, reason: 'Observed impact', sourceVersion: 'a'.repeat(64),
    } };
  });
  s.provider.assigned = async () => observations;
  s.provider.issue = async (_repo, number) => observations[number - 1].issue;
  const inbox = await s.runtime().invoke('receive', {}, s.caller('receiver', 'inbox')) as any[];
  assert.deepEqual(inbox.map(row => row.score), [9, 5, null]);
});

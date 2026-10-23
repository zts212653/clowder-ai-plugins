import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import type { ModulePluginHostShape, PluginOwnerOperationContext } from '@clowder-ai/plugin-sdk';
import { createIssueTeamModule } from '../src/team/plugin-entrypoint.js';
import { setup } from './helpers/team-fixture.js';

const manifest = parse(readFileSync(new URL('../plugin.yaml', import.meta.url), 'utf8'));
function host(s: ReturnType<typeof setup>): ModulePluginHostShape {
  return { ...s.context, dataPath: '/isolated-test', secrets: { get: async () => undefined },
    messaging: { ...s.context.messaging, send: ({ threadId, ...draft }) => s.context.messaging.send(threadId, draft) },
  } as ModulePluginHostShape;
}
function owner(actionId: string, overrides = {}): PluginOwnerOperationContext {
  return { kind: 'owner-operation', userId: 'owner', pluginInstanceId: 'isolated-test',
    operationKey: 'teamWorkbench', actionId, requestId: 'http-' + actionId,
    signal: new AbortController().signal, assertCurrent: async () => {}, ...overrides };
}
async function fixture() {
  const s = setup();
  s.config.analysisThreadId = 'analysis';
  s.config.automaticAssignment = false;
  const active = await createIssueTeamModule(s.provider).create(manifest).start(host(s));
  const call = async (method: string, input = {}, authority = owner(method)) => {
    const handler = active.actions['issue.workbench.' + method];
    assert.equal(typeof handler, 'function', `declared owner action ${method} must be callable`);
    return handler!( { input: { ...s.config, payload: JSON.stringify(input) } }, undefined, authority) as Promise<any>;
  };
  return { ...s, active, call };
}

test('owner workbench sends a real module request, reads the submitted result and records explicit feedback', async () => {
  const s = await fixture();
  const summary = await s.call('summary');
  assert.equal(summary.render, 'status');
  assert.equal(summary.data.settings.automaticAssignment, false);
  const response = await s.call('analyze', { repo: 'fixture/repo', number: 1, requestId: 'click-1' });
  const job = response.data;
  assert.equal(job.status, 'delivered');
  assert.equal(job.requesterKind, 'owner');
  assert.equal(job.ownerUserId, 'owner');
  assert.equal(job.sourceMessageId, undefined, 'Settings must not fabricate a conversation message');
  assert.equal(s.sends.size, 1);
  await s.call('analyze', { repo: 'fixture/repo', number: 1, requestId: 'click-1' });
  assert.equal(s.sends.size, 1);
  await s.active.actions['issue.team.submit']!({ id: job.id, analysis: s.analysis }, {
    ...s.caller(), source: undefined, originTriggerMessageId: job.messageId,
  });
  const current = await s.call('get', { id: job.id });
  assert.equal(current.data.analysis.score, 9);
  assert.equal(current.data.sourceStale, false);
  await s.call('feedback', { id: job.id, verdict: 'corrected', reason: 'There is now a workaround', expectedRevision: current.data.revision });
  const updated = (await s.call('summary')).data;
  assert.equal(updated.statistics.corrected, 1);
  assert.deepEqual(updated.statistics.scores, { '9': 1 });
  assert.deepEqual(updated.statistics.assignments, {});
  assert.equal(updated.statistics.trainingPerformed, false);
  assert.equal(s.writes.length, 0);
  await s.active.stop();
});

test('owner actions reject caller impersonation, wrong action, expired authority and unconfigured routes before sending', async () => {
  const s = await fixture();
  const payload = { repo: 'fixture/repo', number: 1, requestId: 'click-1' };
  await assert.rejects(s.call('analyze', payload, owner('summary')), /authority|action/i);
  await assert.rejects(s.call('analyze', payload, owner('analyze', { pluginInstanceId: 'foreign' })), /authority|instance/i);
  await assert.rejects(s.call('analyze', payload, owner('analyze', { assertCurrent: async () => { throw new Error('expired authority'); } })), /expired/);
  await assert.rejects(s.call('analyze', { ...payload, catId: 'attacker' }), /routable/i);
  delete s.config.analysisThreadId;
  await assert.rejects(s.call('analyze', payload), /thread|对话/i);
  assert.equal(s.sends.size, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(s.call('summary', {}, owner('summary', { signal: controller.signal })), /abort/i);
  await s.active.stop();
});

test('opening an issue loads members and available cats without sending or persisting a request', async () => {
  const s = await fixture();
  const view = (await s.call('summary', { repo: 'fixture/repo', number: 1 })).data;
  assert.deepEqual(view.issueContext.assignmentOptions.members, ['alice', 'bob']);
  assert.equal(view.issueContext.currentIssue.number, 1);
  assert.deepEqual(view.analysisCats.map((cat: any) => cat.catId), ['analyst', 'receiver']);
  assert.equal(s.sends.size, 0);
  assert.deepEqual(await s.context.storage.list(), {});
  await s.active.stop();
});

test('owner-selected cat receives classification and restricted assignment task; replay keeps the selected destination', async () => {
  const s = await fixture();
  const input = { repo: 'fixture/repo', number: 1, requestId: 'choose-cat', catId: 'receiver' };
  const job = (await s.call('analyze', input)).data;
  assert.equal(job.catId, 'receiver');
  const sent = [...s.sends.values()][0];
  assert.equal(sent.draft.wake.catId, 'receiver');
  assert.match(sent.draft.payload.elements[0].payload.text, /分类.*人员指派/);
  assert.match(sent.draft.payload.elements[0].payload.text, /已有负责人/);
  assert.match(sent.draft.payload.elements[0].payload.text, /自动指派未开启/);
  await assert.rejects(s.call('analyze', { ...input, catId: 'analyst' }), /target|目标/);
  await assert.rejects(s.active.actions['issue.team.submit']!({ id: job.id, analysis: s.analysis }, s.caller()), /target/);
  await s.active.actions['issue.team.submit']!({ id: job.id, analysis: s.analysis }, s.caller('receiver'));
  assert.equal((await s.call('get', { id: job.id })).data.provenance.catId, 'receiver');
  assert.deepEqual(s.writes, []);
  await s.active.stop();
});

test('owner can assign directly before analysis with source fencing and no invented analysis', async () => {
  const s = await fixture();
  const view = (await s.call('summary', { repo: 'fixture/repo', number: 1 })).data;
  const input = { repo: 'fixture/repo', number: 1, requestId: 'direct', login: 'alice', sourceVersion: view.issueContext.sourceVersion };
  await assert.rejects(s.call('assignIssue', { ...input, sourceVersion: '0'.repeat(64) }), /Source changed/);
  await assert.rejects(s.call('assignIssue', { ...input, login: 'mallory' }), /group|成员/);
  assert.deepEqual(s.writes, []);
  const assigned = (await s.call('assignIssue', input)).data;
  assert.equal(assigned.kind, 'assignment');
  assert.equal(assigned.assignment.status, 'assigned');
  assert.equal(assigned.analysis, undefined);
  assert.equal(s.sends.size, 0);
  assert.deepEqual(s.writes, ['alice']);
  assert.equal(s.dispatches[0].score, null);
  await s.call('assignIssue', input);
  assert.deepEqual(s.writes, ['alice']);
  await assert.rejects(s.call('assignIssue', { ...input, login: 'bob' }), /target|目标/);
  const stats = (await s.call('summary')).data.statistics;
  assert.equal(stats.analyzed, 0);
  assert.deepEqual(stats.assignments, { alice: 1 });
  assert.ok(manifest.configuration.find((setting: any) => setting.key === 'teamWorkbench')
    .actions.find((action: any) => action.id === 'assignIssue')?.confirm);
  await s.active.stop();
});

test('one owner assignment selects only a current group member and does not enable automatic dispatch', async () => {
  const s = await fixture();
  const job = (await s.call('analyze', { repo: 'fixture/repo', number: 1, requestId: 'manual' })).data;
  await s.active.actions['issue.team.submit']!({ id: job.id, analysis: s.analysis }, s.caller());
  const current = (await s.call('get', { id: job.id })).data;
  const input = { id: job.id, expectedRevision: current.revision, login: 'mallory' };
  await assert.rejects(s.call('assign', input), /group|成员/);
  await assert.rejects(s.call('assign', { ...input, login: 'alice', expectedRevision: 0 }), /changed|revision/i);
  await assert.rejects(s.call('assign', { ...input, login: 'alice' }, owner('summary')), /authority|action/i);
  assert.deepEqual(s.writes, []);
  await s.call('assign', { ...input, login: 'alice' });
  assert.deepEqual(s.writes, ['alice']);
  assert.equal(s.dispatches.length, 1);
  assert.equal(s.config.automaticAssignment, false);
  const assigned = (await s.call('get', { id: job.id })).data;
  assert.equal(assigned.assignment.basis, 'manual');
  await assert.rejects(s.call('assign', { ...input, login: 'alice' }), /changed|revision/i);
  assert.ok(manifest.configuration.find((setting: any) => setting.key === 'teamWorkbench')
    .actions.find((action: any) => action.id === 'assign')?.confirm, 'the public Host operation must enforce confirmation');
  await s.active.stop();
});

test('failed direct assignment needs renewed owner confirmation even if automatic routing is enabled later', async () => {
  const s = await fixture(); s.issues[0].author = 'alice';
  const view = (await s.call('summary', { repo: 'fixture/repo', number: 1 })).data;
  s.provider.canWrite = async () => false;
  const input = { repo: 'fixture/repo', number: 1, requestId: 'direct-failure', login: 'alice', sourceVersion: view.issueContext.sourceVersion };
  const job = (await s.call('assignIssue', input)).data;
  assert.equal(job.assignment.status, 'pending');
  s.provider.canWrite = async () => true;
  s.config.automaticAssignment = true;
  await s.runtime().recover();
  await s.call('retry', { id: job.id });
  assert.deepEqual(s.writes, []);
  const current = (await s.call('get', { id: job.id })).data;
  await s.call('assign', { id: job.id, expectedRevision: current.revision, login: 'alice' });
  assert.deepEqual(s.writes, ['alice']);
  await s.active.stop();
});

test('selected cat survives a failed send and default-cat change without granting a different thread', async () => {
  const s = await fixture(); s.failSend(true);
  const job = (await s.call('analyze', { repo: 'fixture/repo', number: 1, requestId: 'pending-selected', catId: 'receiver' })).data;
  assert.equal(job.status, 'pending');
  s.config.analysisCatId = 'different-default';
  s.config.analysisThreadId = 'different-thread';
  s.failSend(false);
  await s.runtime().recover();
  assert.equal(s.sends.size, 0);
  s.config.analysisThreadId = 'analysis';
  await s.runtime().recover();
  assert.equal(s.sends.size, 1);
  assert.equal([...s.sends.values()][0].draft.wake.catId, 'receiver');
  await s.active.stop();
});

test('configured cats include unavailable members for display but only currently routable cats can receive', async () => {
  const s = await fixture();
  s.context.threads.getCats = async () => ({ participants: [], routableNow: [],
    routableNotJoined: [{ catId: 'new-cat', displayName: 'New cat', aliases: [] }],
    notRoutable: [{ catId: 'offline', displayName: 'Offline', aliases: [] }] });
  const summary = (await s.call('summary')).data;
  assert.deepEqual(summary.analysisCats, [
    { catId: 'new-cat', displayName: 'New cat', available: true },
    { catId: 'offline', displayName: 'Offline', available: false },
  ]);
  const request = { repo: 'fixture/repo', number: 1, requestId: 'new-cat', catId: 'new-cat' };
  await s.call('analyze', request);
  assert.equal([...s.sends.values()][0].draft.wake.catId, 'new-cat');
  await assert.rejects(s.call('analyze', { ...request, requestId: 'offline', catId: 'offline' }), /routable/);
  await s.active.stop();
});

test('a failed manual assignment is retained without becoming permission for a background retry', async () => {
  const s = await fixture();
  const job = (await s.call('analyze', { repo: 'fixture/repo', number: 1, requestId: 'manual-failed' })).data;
  await s.active.actions['issue.team.submit']!({ id: job.id, analysis: s.analysis }, s.caller());
  const current = (await s.call('get', { id: job.id })).data;
  const assign = s.provider.addAssignee;
  s.provider.addAssignee = async () => { throw new Error('Provider unavailable'); };
  await s.call('assign', { id: job.id, expectedRevision: current.revision, login: 'alice' });
  s.provider.addAssignee = assign;
  s.config.automaticAssignment = true;
  await s.runtime().recover();
  assert.deepEqual(s.writes, [], 'a later automatic policy cannot resume a one-time manual intent');
  const pending = (await s.call('get', { id: job.id })).data;
  await s.call('assign', { id: job.id, expectedRevision: pending.revision, login: 'alice' });
  assert.deepEqual(s.writes, ['alice']);
  await s.active.stop();
});

test('invalid automatic routing retains the explicit group for owner selection', async () => {
  const s = await fixture();
  s.config.routingRules = '{broken';
  const job = (await s.call('analyze', { repo: 'fixture/repo', number: 1, requestId: 'manual-invalid-rules' })).data;
  await s.active.actions['issue.team.submit']!({ id: job.id, analysis: s.analysis }, s.caller());
  const current = (await s.call('get', { id: job.id })).data;
  assert.deepEqual(current.assignmentOptions.members, ['alice', 'bob']);
  assert.match(current.assignmentOptions.error, /规则/);
  await s.call('assign', { id: job.id, expectedRevision: current.revision, login: 'alice' });
  assert.deepEqual(s.writes, ['alice']);
  await s.active.stop();
});

test('an owner request that expires during source lookup cannot persist or send a job', async () => {
  const s = await fixture();
  let current = true;
  const issue = s.provider.issue;
  s.provider.issue = async (...args) => { const result = await issue(...args); current = false; return result; };
  await assert.rejects(s.call('analyze', { repo: 'fixture/repo', number: 1, requestId: 'late' },
    owner('analyze', { assertCurrent: async () => { if (!current) throw new Error('expired authority'); } })), /expired/);
  assert.equal(s.sends.size, 0);
  assert.equal(Object.keys(await s.context.storage.list()).length, 0);
  await s.active.stop();
});

test('unknown dispatch publication requires explicit owner retry with the current revision; replay cannot republish', async () => {
  const s = await fixture();
  s.config.automaticAssignment = true;
  const attempts: boolean[] = [];
  s.provider.publishDispatch = async (_issue, _dispatch, _signal, create) => {
    attempts.push(create);
    if (attempts.length < 3 || !create) throw new Error('Previous comment outcome unknown');
    return 'confirmed-comment';
  };
  const job = (await s.call('analyze', { repo: 'fixture/repo', number: 1, requestId: 'publish' })).data;
  await s.active.actions['issue.team.submit']!({ id: job.id, analysis: s.analysis }, s.caller());
  await s.call('retry', { id: job.id });
  assert.deepEqual(attempts, [true, false]);
  const current = (await s.call('get', { id: job.id })).data;
  const confirmation = { id: job.id, expectedRevision: current.revision };
  await s.call('republish', confirmation);
  assert.deepEqual(attempts, [true, false, true]);
  await assert.rejects(s.call('republish', confirmation), /changed|reload|revision/i);
  assert.equal(attempts.length, 3);
  assert.deepEqual((await s.call('summary')).data.statistics.assignments, { alice: 1 });
  await s.active.stop();
});

test('closing or reassigning an inbox issue sends one durable withdrawal notice to its original conversation', async () => {
  const s = setup(); s.login('alice'); s.issues[0].assignees = ['alice'];
  await s.runtime().recover();
  assert.equal(s.sends.size, 1);
  s.issues[0].state = 'closed'; s.failSend(true);
  await s.runtime().recover();
  assert.equal(s.sends.size, 1);
  s.failSend(false);
  await s.runtime().recover();
  assert.equal(s.sends.size, 2, 'a failed change notice is retried after restart');
  const notice = [...s.sends.values()][1];
  assert.equal(notice.threadId, 'inbox');
  assert.match(notice.draft.payload.elements[0].payload.text, /关闭|撤回|转派/);
  await s.runtime().recover();
  assert.equal(s.sends.size, 2);
});

test('reopening the same assignment resumes intake with a new notification and preserves the withdrawal history', async () => {
  const s = setup(); s.login('alice'); s.issues[0].assignees = ['alice'];
  await s.runtime().recover();
  s.issues[0].state = 'closed';
  await s.runtime().recover();
  s.issues[0].state = 'open';
  await s.runtime().recover();
  const inbox = await s.runtime().invoke('receive', {}, s.caller('receiver', 'inbox')) as any[];
  assert.equal(inbox[0].status, 'delivered');
  assert.equal(s.sends.size, 3, 'reopening is a new notification cycle even when the GitHub assignment event stays the same');
  assert.equal(inbox[0].withdrawalHistory.length, 1);
  s.issues[0].state = 'closed';
  await s.runtime().recover();
  assert.equal(s.sends.size, 4, 'the second closure also has its own idempotency key');
});

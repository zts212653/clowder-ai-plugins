import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './helpers/team-fixture.js';
import { issueCategory, newInvestigation } from '../src/model/issue-coordination.js';

function fixture() {
  const s = setup();
  s.config.analysisThreadId = 'analysis';
  s.config.receiveAssignments = false;
  s.config.automaticAssignment = false;
  s.provider.allIssues = async repo => structuredClone(s.issues.filter(issue => issue.repo === repo));
  const call = (runtime: ReturnType<typeof s.runtime>, method: string, input: unknown = {}) => runtime.invokeOwner(method, input, {
    kind: 'owner-operation', userId: 'owner', pluginInstanceId: 'isolated-test', operationKey: 'teamWorkbench',
    actionId: method, requestId: 'operation-' + method, signal: new AbortController().signal, assertCurrent: async () => {},
  }) as Promise<any>;
  return { ...s, call };
}

test('installed coordination exposes current GitHub claims, not invitation or historical assignment records', async () => {
  const s = fixture(); const runtime = s.runtime();
  const load = async () => (await s.call(runtime, 'coordination', { action: 'load' })).sources[0].issues[0];
  assert.deepEqual((await load()).assignees, []);
  const context = (await s.call(runtime, 'summary', { repo: 'fixture/repo', number: 1 })).issueContext;
  const input = { repo: 'fixture/repo', number: 1, requestId: 'claim', login: 'alice', sourceVersion: context.sourceVersion };
  await s.call(runtime, 'assignIssue', { ...input, delivery: 'invitation' });
  assert.deepEqual((await load()).assignees, [], 'an invitation does not establish ownership');
  await s.call(runtime, 'assignIssue', { ...input, requestId: 'mark-claim', delivery: 'assignment' });
  assert.deepEqual((await load()).assignees, ['alice']);
  s.issues[0].assignees = ['bob', 'carol'];
  assert.deepEqual((await load()).assignees, ['bob', 'carol'], 'remote reassignment supersedes local history');
  const detail = await s.call(runtime, 'coordination', { action: 'detail', ref: { sourceId: 'github:fixture/repo', issueId: 'issue-1', number: 1 } });
  assert.deepEqual(detail.fact.assignees, ['bob', 'carol']);
  s.issues[0].assignees = [];
  assert.deepEqual((await load()).assignees, []);
  assert.deepEqual(s.writes, ['alice']);
  await runtime.stop();
});

test('integration starts one durable initial classification including closed history, resumes without duplicate messages', async () => {
  const s = fixture(); s.config.initialClassification = true;
  s.issues.push({ ...s.issues[0], id: 'closed-2', number: 2, state: 'closed', url: 'https://github.com/fixture/repo/issues/2' });
  let runtime = s.runtime(); await runtime.recover();
  let queue = (await s.call(runtime, 'summary')).classificationQueues[0];
  assert.equal(queue.items.length, 2); assert.equal(queue.origin, 'integration');
  assert.equal(s.sends.size, 1); assert.deepEqual(s.writes, []);
  await runtime.stop(); runtime = s.runtime(); await runtime.recover();
  assert.equal(s.sends.size, 1);
  await runtime.invoke('submit', { id: queue.items[0].jobId, analysis: s.analysis }, s.caller());
  await runtime.recover(); queue = (await s.call(runtime, 'summary')).classificationQueues[0];
  await runtime.invoke('submit', { id: queue.items[1].jobId, analysis: s.analysis }, s.caller());
  await runtime.recover(); await runtime.recover();
  queue = (await s.call(runtime, 'summary')).classificationQueues[0];
  assert.equal(queue.status, 'completed'); assert.equal(s.sends.size, 2);
  assert.equal((await s.call(runtime, 'summary')).classificationQueues.length, 1);
  assert.deepEqual(s.writes, []); await runtime.stop();
});

test('automatic dispatch continues partial batches and never repeats an uncertain publication after restart', async () => {
  const s = fixture(); const runtime = s.runtime();
  s.config.automaticAssignment = true; s.issues[0].author = 'alice';
  s.issues.push({ ...structuredClone(s.issues[0]), id: 'issue-2', number: 2, url: 'https://github.com/fixture/repo/issues/2' });
  const publish = s.provider.publishDispatch; let failed = false;
  s.provider.publishDispatch = async (issue, ...args) => {
    if (issue.number === 1 && !failed) { failed = true; throw new Error('Connection lost before reply'); }
    if (issue.number === 1 && args[2] === false) throw new Error('Previous publication outcome unknown');
    return publish(issue, ...args);
  };
  await runtime.recover();
  assert.deepEqual(s.writes, ['alice', 'alice']);
  assert.equal(s.dispatches.length, 1, 'second issue continues despite first publication failure');
  await runtime.stop(); const restarted = s.runtime(); await restarted.recover();
  assert.equal(s.dispatches.length, 1, 'uncertain first publication requires its own explicit retry');
  assert.deepEqual(s.writes, ['alice', 'alice']); await restarted.stop();
});

test('initial classification opt-out and inaccessible sources do not enqueue work', async () => {
  const s = fixture(); const runtime = s.runtime(); await runtime.recover();
  assert.equal(s.sends.size, 0);
  s.config.initialClassification = true;
  s.provider.allIssues = async () => { throw new Error('Incomplete inventory'); };
  const results = await runtime.recover();
  assert.match(results[0].error!, /Incomplete/);
  assert.equal((await s.call(runtime, 'summary')).classificationQueues.length, 0);
  assert.equal(s.sends.size, 0); await runtime.stop();
});

test('a concurrent human classification edit fences automatic assignment before its first external write', async () => {
  const s = fixture(); const runtime = s.runtime(), editor = s.runtime();
  const snapshot = await s.call(editor, 'coordination', { action: 'load' }), source = snapshot.sources[0], fact = source.issues[0];
  const work = newInvestigation({ sourceId: source.profile.id, issueId: fact.id, number: fact.number }, fact.title, fact.contentVersion, source.preference.value);
  work.module = 'Agent 运行';
  const saved = await s.call(editor, 'coordination', { action: 'saveWork', value: work, expectedRevision: 0 });
  s.config.automaticAssignment = true;
  s.provider.canWrite = async () => {
    work.module = '代码与交付';
    await s.call(editor, 'coordination', { action: 'saveWork', value: work, expectedRevision: saved.revision });
    return true;
  };
  await runtime.recover();
  assert.deepEqual(s.writes, []); assert.deepEqual(s.dispatches, []);
  const row = (await s.call(runtime, 'summary', { kind: 'assignment' })).rows[0];
  assert.match(row.assignment.reason, /policy changed/);
  await runtime.stop(); await editor.stop();
});

test('saved human category drives both grouping and independent automatic assignment without a cat invocation', async () => {
  const s = fixture(); const runtime = s.runtime();
  s.config.routingRules = JSON.stringify([{ login: 'alice', categories: ['代码与交付'], features: [] }]);
  let snapshot = await s.call(runtime, 'coordination', { action: 'load' });
  const source = snapshot.sources[0], fact = source.issues[0];
  const work = newInvestigation({ sourceId: source.profile.id, issueId: fact.id, number: fact.number }, fact.title, fact.contentVersion,
    source.preference.value);
  work.module = '代码与交付'; work.notes = '人工确认：开发测试命令的问题';
  await s.call(runtime, 'coordination', { action: 'saveWork', value: work, expectedRevision: 0 });
  snapshot = await s.call(runtime, 'coordination', { action: 'load' });
  assert.equal(issueCategory({ source: snapshot.sources[0], fact }).label, '代码与交付');
  const summary = await s.call(runtime, 'summary', { repo: fact.repo ?? 'fixture/repo', number: fact.number });
  assert.equal(summary.issueContext.effectiveCategory.label, '代码与交付');
  assert.equal(summary.issueContext.assignmentOptions.preferredLogin, 'alice');
  await runtime.recover(); assert.deepEqual(s.writes, []);
  s.config.automaticAssignment = true;
  await runtime.recover(); await runtime.recover();
  assert.deepEqual(s.writes, ['alice']); assert.equal(s.dispatches.length, 1); assert.equal(s.sends.size, 0);
  await runtime.stop();
});

test('human correction survives a later cat result and retains prior authored versions', async () => {
  const s = fixture(); const runtime = s.runtime();
  const snapshot = await s.call(runtime, 'coordination', { action: 'load' }), source = snapshot.sources[0], fact = source.issues[0];
  const work = newInvestigation({ sourceId: source.profile.id, issueId: fact.id, number: fact.number }, fact.title, fact.contentVersion, source.preference.value);
  work.module = '代码与交付'; work.notes = '第一次人工判断';
  const saved = await s.call(runtime, 'coordination', { action: 'saveWork', value: work, expectedRevision: 0 });
  const job = await s.call(runtime, 'analyze', { repo: 'fixture/repo', number: 1, requestId: 'cat-again' });
  await runtime.invoke('submit', { id: job.id, analysis: { ...s.analysis, category: 'Agent 运行' } }, s.caller());
  const current = await s.call(runtime, 'coordination', { action: 'load' });
  assert.equal(issueCategory({ source: current.sources[0], fact }).label, '代码与交付');
  work.notes = '补充人工依据';
  await s.call(runtime, 'coordination', { action: 'saveWork', value: work, expectedRevision: saved.revision });
  const history = await s.call(runtime, 'coordination', { action: 'workHistory', ref: work.ref });
  assert.deepEqual(history.map((entry: any) => entry.value.notes), ['第一次人工判断', '补充人工依据']);
  assert.deepEqual(s.writes, []); await runtime.stop();
});

test('owner acceptance survives restart, retains its source and requires current assignment and revision', async () => {
  const s = fixture(); s.config.receiveAssignments = true; s.login('alice'); s.issues[0].assignees = ['alice'];
  let runtime = s.runtime(); await runtime.recover();
  const row = (await s.call(runtime, 'summary', { kind: 'inbox' })).rows[0];
  let detail = await s.call(runtime, 'get', { id: row.id });
  assert.equal(detail.receiver.threadUrl, 'https://host.test/thread/inbox');
  const sends = s.sends.size;
  await s.call(runtime, 'acceptInbox', { id: row.id, expectedRevision: detail.revision });
  await runtime.stop(); runtime = s.runtime();
  detail = await s.call(runtime, 'get', { id: row.id });
  assert.equal(detail.ownerAcceptance.userId, 'owner');
  assert.equal(detail.ownerAcceptance.operationId, 'operation-acceptInbox');
  assert.match(detail.receiver.requestText, /fixture\/repo#1/);
  assert.equal(s.sends.size, sends, 'local acceptance is not synthetic owner speech or a new execution');
  await assert.rejects(s.call(runtime, 'acceptInbox', { id: row.id, expectedRevision: detail.revision - 1 }), /changed/);
  s.issues[0].assignees = [];
  await assert.rejects(s.call(runtime, 'acceptInbox', { id: row.id, expectedRevision: detail.revision }), /changed/);
  assert.deepEqual(s.writes, []); await runtime.stop();
});

test('independent assignment picks up a later human classification even while cat analysis is pending', async () => {
  const s = fixture(); const runtime = s.runtime(); s.config.automaticAssignment = true;
  s.config.routingRules = JSON.stringify([{ login: 'alice', categories: ['代码与交付'], features: [] }]);
  await runtime.recover(); assert.equal(s.dispatches.length, 0);
  await s.call(runtime, 'analyze', { repo: 'fixture/repo', number: 1, requestId: 'slow-cat' });
  const snapshot = await s.call(runtime, 'coordination', { action: 'load' }), source = snapshot.sources[0], fact = source.issues[0];
  const work = newInvestigation({ sourceId: source.profile.id, issueId: fact.id, number: fact.number }, fact.title, fact.contentVersion, source.preference.value);
  work.module = '代码与交付';
  await s.call(runtime, 'coordination', { action: 'saveWork', value: work, expectedRevision: 0 });
  await runtime.recover();
  assert.equal(s.dispatches.length, 1); assert.deepEqual(s.writes, ['alice']);
  await runtime.stop();
});

test('discussion pagination keeps one snapshot and detects edits before appending another page', async () => {
  const s = fixture(); const runtime = s.runtime();
  let edited = false;
  s.provider.discussion = async () => Array.from({ length: 26 }, (_, i) => ({ id: String(i), author: 'alice',
    body: edited ? 'edited' : 'original', createdAt: '2026-10-23', updatedAt: '2026-10-23', lastEditedAt: null, url: '' }));
  const ref = { sourceId: 'github:fixture/repo', issueId: 'issue-1', number: 1 };
  const first = await s.call(runtime, 'coordination', { action: 'detail', ref });
  assert.equal(first.fact.comments.length, 25); assert.equal(first.nextOffset, 25);
  const second = await s.call(runtime, 'coordination', { action: 'detail', ref, offset: 25, version: first.pageVersion });
  assert.equal(second.fact.comments.length, 1); assert.equal(second.nextOffset, null);
  edited = true;
  await assert.rejects(s.call(runtime, 'coordination', { action: 'detail', ref, offset: 25, version: first.pageVersion }), /讨论已变化/);
  await runtime.stop();
});

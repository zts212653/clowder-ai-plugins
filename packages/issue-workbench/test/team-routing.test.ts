import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './helpers/team-fixture.js';
import { issueVersion } from '../src/team/schema.js';
import { newInvestigation } from '../src/model/issue-coordination.js';
import { issueFact, sourceId } from '../src/team/coordination.js';

function fixture(system = 'Windows') {
  const s = setup();
  s.config.analysisThreadId = 'analysis';
  s.issues[0].body = `The café cannot start. No workaround.\n## Environment\n${system}`;
  s.members.splice(0, s.members.length, 'alice', 'bob', 'architect', 'planner', 'unconfigured');
  s.config.memberProfiles = JSON.stringify([
    { login: 'alice', system: 'macos', role: 'member', weight: 2 },
    { login: 'bob', system: 'windows', role: 'member', weight: 1 },
    { login: 'architect', system: 'macos', role: 'architect-reviewer', weight: 1 },
    { login: 'planner', system: 'windows', role: 'core-planner', weight: 1 },
  ]);
  s.provider.assignable = async () => true;
  return s;
}
function owner(s: ReturnType<typeof fixture>, actionId: string) {
  return { kind: 'owner-operation' as const, pluginInstanceId: s.context.pluginInstanceId, operationKey: 'teamWorkbench',
    actionId, userId: 'owner', requestId: actionId, signal: new AbortController().signal, async assertCurrent() {} };
}
async function analyze(s: ReturnType<typeof fixture>, number = 1) {
  const r = s.runtime();
  const job = await r.invoke('analyze', { repo: 'fixture/repo', number, requestId: `routing-${number}` }, s.caller('requester')) as any;
  return await r.invoke('submit', { id: job.id, analysis: s.analysis }, s.caller()) as any;
}

test('a Mac reporter and category rule cannot bypass a Windows issue environment', async () => {
  const s = fixture(); s.issues[0].author = 'alice';
  const job = await analyze(s);
  assert.deepEqual(s.writes, ['bob']);
  assert.equal(job.assignment.status, 'assigned');
});

test('direct owner assignment and analyzed assignment both reject an incompatible member', async () => {
  for (const path of ['assignIssue', 'assign'] as const) {
    const s = fixture(); s.config.automaticAssignment = false;
    const r = s.runtime();
    const job = path === 'assign' ? await analyze(s) : undefined;
    const detail = job && await r.invoke('get', { id: job.id }, s.caller()) as any;
    const result = await r.invokeOwner(path, path === 'assign' ? { id: job.id, expectedRevision: detail.revision, login: 'alice' }
      : { repo: 'fixture/repo', number: 1, requestId: 'manual', sourceVersion: issueVersion(s.issues[0]), login: 'alice' }, owner(s, path)) as any;
    assert.equal(result.assignment.status, 'needs-decision');
    assert.match(result.assignment.reason, /系统|环境/);
    assert.deepEqual(s.writes, []); assert.deepEqual(s.dispatches, []);
  }
});

test('unknown, other and multiple systems block even a member reporter and explicit owner target', async () => {
  for (const system of ['', 'Linux', 'Windows and macOS']) {
    const s = fixture(system); s.issues[0].author = 'alice';
    const job = await analyze(s);
    assert.equal(job.assignment.status, 'needs-decision');
    assert.deepEqual(s.writes, []);
    const r = s.runtime(), detail = await r.invoke('get', { id: job.id }, s.caller()) as any;
    await r.invokeOwner('assign', { id: job.id, expectedRevision: detail.revision, login: 'alice' }, owner(s, 'assign'));
    assert.deepEqual(s.writes, []); assert.deepEqual(s.dispatches, []);
  }
});

test('architect and Windows core-plan duties precede an otherwise eligible reporter', async () => {
  for (const [system, reporter, expected] of [['macOS', 'alice', 'architect'], ['Windows', 'bob', 'planner']]) {
    const s = fixture(system); s.issues[0].title = 'Framework architecture proposal'; s.issues[0].author = reporter;
    await analyze(s); assert.deepEqual(s.writes, [expected]);
  }
});

test('saved human unknown outranks a known source system and survives reload', async () => {
  const s = fixture(); s.config.automaticAssignment = false;
  const r = s.runtime(), fact = issueFact(s.issues[0]);
  const value = { ...newInvestigation({ sourceId: sourceId(s.issues[0].repo), issueId: fact.id!, number: 1 }, fact.title,
    issueVersion(s.issues[0]), { enabled: true, name: '', branch: '', base: '' }), affectedSystems: [] };
  const saved = await r.invokeOwner('coordination', { action: 'saveWork', value, expectedRevision: 0 }, owner(s, 'coordination')) as any;
  assert.deepEqual(saved.value.affectedSystems, []);
  const summary = await s.runtime().invokeOwner('summary', { repo: 'fixture/repo', number: 1 }, owner(s, 'summary')) as any;
  assert.equal(summary.issueContext.assignmentOptions.preferredLogin, undefined);
  assert.match(summary.issueContext.assignmentOptions.blockedReason, /系统|环境/);
});

test('multiple ordinary members use persistent weighted allocation without counting replay twice', async () => {
  const s = fixture('macOS'); s.config.routingRules = '[]';
  const profiles = JSON.parse(s.config.memberProfiles as string); profiles[1].system = 'macos';
  s.config.memberProfiles = JSON.stringify(profiles);
  const original = structuredClone(s.issues[0]);
  s.issues.splice(0, 1, ...Array.from({ length: 6 }, (_, i) => ({ ...structuredClone(original), number: i + 1, id: `issue-${i + 1}` })));
  for (let i = 1; i <= 6; i++) {
    const job = await analyze(s, i);
    await s.runtime().invokeOwner('retry', { id: job.id }, owner(s, 'retry'));
  }
  assert.equal(s.writes.filter(login => login === 'alice').length, 4);
  assert.equal(s.writes.filter(login => login === 'bob').length, 2);
  assert.equal(s.writes.length, 6);
});

test('cat systems override source inference, then saved human systems override cat without rewriting it', async () => {
  const s = fixture('Windows'); s.config.automaticAssignment = false;
  const r = s.runtime();
  const job = await r.invoke('analyze', { repo: 'fixture/repo', number: 1, requestId: 'structured' }, s.caller('requester')) as any;
  await r.invoke('submit', { id: job.id, analysis: { ...s.analysis, affectedSystems: ['macos'], routingFocus: 'framework' } }, s.caller());
  const summary = async () => await s.runtime().invokeOwner('summary', { repo: 'fixture/repo', number: 1 }, owner(s, 'summary')) as any;
  assert.equal((await summary()).issueContext.assignmentOptions.preferredLogin, 'architect');
  const value = { ...newInvestigation({ sourceId: sourceId(s.issues[0].repo), issueId: s.issues[0].id, number: 1 }, s.issues[0].title,
    issueVersion(s.issues[0]), { enabled: true, name: '', branch: '', base: '' }), affectedSystems: ['windows'], routingFocus: 'general' };
  await r.invokeOwner('coordination', { action: 'saveWork', value, expectedRevision: 0 }, owner(s, 'coordination'));
  const view = await summary();
  assert.equal(view.issueContext.assignmentOptions.preferredLogin, 'bob');
  assert.equal(view.issueContext.assignmentOptions.systemsSource, 'human');
  assert.deepEqual(view.issueContext.analysis.affectedSystems, ['macos']);
  s.issues[0].body += '\nchanged';
  assert.match((await summary()).issueContext.assignmentOptions.blockedReason, /原文已变化/);
});

test('malformed capability profiles and unknown member capabilities fail closed; managed-user logins remain supported', async () => {
  for (const profiles of ['{broken', '[{"login":"alice","system":"linux","role":"member","weight":1}]', '[]']) {
    const s = fixture('macOS'); s.config.memberProfiles = profiles; s.issues[0].author = 'alice';
    await analyze(s); assert.deepEqual(s.writes, []);
  }
  const s = fixture('macOS'); s.members.push('Alice_Acme'); s.issues[0].author = 'Alice_Acme';
  const profiles = JSON.parse(s.config.memberProfiles as string);
  profiles.push({ login: 'Alice_Acme', system: 'macos', role: 'member', weight: 1 }); s.config.memberProfiles = JSON.stringify(profiles);
  await analyze(s); assert.deepEqual(s.writes, ['alice_acme']);
});

test('a changed member environment fences a write already awaiting provider permission', async () => {
  const s = fixture('macOS');
  s.provider.assignable = async () => {
    const profiles = JSON.parse(s.config.memberProfiles as string); profiles[0].system = 'windows';
    s.config.memberProfiles = JSON.stringify(profiles); return true;
  };
  await analyze(s); assert.deepEqual(s.writes, []); assert.deepEqual(s.dispatches, []);
});

test('a confirmed republish cannot notify a now-incompatible member', async () => {
  const s = fixture('macOS');
  s.provider.publishDispatch = async () => { throw new Error('lost response'); };
  const job = await analyze(s), r = s.runtime();
  const detail = await r.invoke('get', { id: job.id }, s.caller()) as any;
  const profiles = JSON.parse(s.config.memberProfiles as string); profiles[0].system = 'windows';
  s.config.memberProfiles = JSON.stringify(profiles);
  let sent = 0; s.provider.publishDispatch = async () => { sent++; return 'comment'; };
  await assert.rejects(r.invokeOwner('republish', { id: job.id, expectedRevision: detail.revision }, owner(s, 'republish')), /系统|环境/);
  assert.equal(sent, 0);
});

test('verified claims consume one weighted slot even when comment publication fails; failed claims consume none', async () => {
  for (const fail of ['comment', 'claim']) {
    const s = fixture('macOS'); s.config.routingRules = '[]';
    const profiles = JSON.parse(s.config.memberProfiles as string); profiles[1].system = 'macos';
    s.config.memberProfiles = JSON.stringify(profiles);
    s.issues.push({ ...structuredClone(s.issues[0]), number: 2, id: 'issue-2' });
    const publish = s.provider.publishDispatch, add = s.provider.addAssignee;
    if (fail === 'comment') s.provider.publishDispatch = async () => { throw new Error('lost response'); };
    else s.provider.addAssignee = async () => { throw new Error('permission changed'); };
    const first = await analyze(s);
    s.provider.publishDispatch = publish; s.provider.addAssignee = add;
    const second = await analyze(s, 2);
    assert.equal(second.assignment.login, fail === 'comment' ? 'bob' : 'alice');
    await s.runtime().invokeOwner('retry', { id: first.id }, owner(s, 'retry'));
    const journal = Object.values(await s.context.storage.list()).map((entry: any) => entry.value)
      .filter((row: any) => row.assignment?.allocation?.committed);
    assert.equal(journal.length, 2);
    assert.equal(s.writes.length, 2);
    assert.equal(new Set(journal.map((row: any) => row.id)).size, 2);
  }
});

test('a Windows core planner also participates in ordinary Windows work, while Mac architects do not consume ordinary slots', async () => {
  const s = fixture('Windows'); s.config.routingRules = '[]';
  s.issues.push({ ...structuredClone(s.issues[0]), number: 2, id: 'issue-2' });
  await analyze(s); await analyze(s, 2);
  assert.deepEqual(s.writes, ['bob', 'planner']);
});

test('owner confirmation of a weighted recommendation advances its durable allocation', async () => {
  const s = fixture('macOS'); s.config.routingRules = '[]'; s.config.automaticAssignment = false;
  const profiles = JSON.parse(s.config.memberProfiles as string); profiles[1].system = 'macos';
  s.config.memberProfiles = JSON.stringify(profiles);
  s.issues.push({ ...structuredClone(s.issues[0]), number: 2, id: 'issue-2' });
  for (const number of [1, 2]) {
    await analyze(s, number);
    const r = s.runtime(), summary = await r.invokeOwner('summary', { repo: 'fixture/repo', number }, owner(s, 'summary')) as any;
    const login = summary.issueContext.assignmentOptions.preferredLogin;
    await r.invokeOwner('assignIssue', { repo: 'fixture/repo', number, requestId: `confirm-${number}`,
      sourceVersion: issueVersion(s.issues[number - 1]), login }, owner(s, 'assignIssue'));
  }
  assert.deepEqual(s.writes, ['alice', 'bob']);
});

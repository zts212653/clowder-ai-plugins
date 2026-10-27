import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './helpers/team-fixture.js';
import { newInvestigation } from '../src/model/issue-coordination.js';
import { issueVersion } from '../src/team/schema.js';
import { sourceId } from '../src/team/coordination.js';

async function fixture(count = 3, classified = true, reporter = false) {
  const s = setup(); s.config.automaticAssignment = false; s.config.analysisThreadId = 'analysis'; s.config.routingRules = '[]';
  s.config.memberProfiles = JSON.stringify([{ login: 'alice', system: 'macos', role: 'member', weight: 2 }, { login: 'bob', system: 'macos', role: 'member', weight: 1 }]);
  s.provider.assignable = async () => true;
  const original = s.issues[0]; s.issues.splice(0, 1, ...Array.from({ length: count }, (_, i) => ({ ...structuredClone(original), id: `issue-${i + 1}`, number: i + 1 })));
  if (reporter) s.issues[0].author = 'alice';
  let runtime = s.runtime();
  const owner = (actionId: string, userId = 'owner') => ({ kind: 'owner-operation' as const, pluginInstanceId: s.context.pluginInstanceId,
    operationKey: 'teamWorkbench', actionId, userId, requestId: 'http-' + actionId, signal: new AbortController().signal, async assertCurrent() {} });
  const call = (action: string, input: unknown = {}, userId?: string): Promise<any> => runtime.invokeOwner(action, input, owner(action, userId));
  if (classified) for (const issue of s.issues) {
    const work = { ...newInvestigation({ sourceId: sourceId(issue.repo), issueId: issue.id, number: issue.number }, issue.title, issueVersion(issue), { enabled: true, name: '', branch: '', base: '' }), module: 'Agent 运行' };
    await call('coordination', { action: 'saveWork', value: work, expectedRevision: 0 });
  }
  return { ...s, call, prepare: () => call('planAssignments', { requestId: 'one-off' }),
    recover: () => runtime.recover(), restart: async () => { await runtime.stop(); runtime = s.runtime(); },
    submit: (id: string) => runtime.invoke('submit', { id, analysis: s.analysis }, s.caller()) };
}

test('Open snapshot previews weighted choices, retains existing owners, and blocks background writes before confirmation', async () => {
  const s = await fixture(7); s.issues[6].assignees = ['bob'];
  const batch = await s.prepare();
  assert.equal(batch.items.length, 7); assert.equal(batch.initiator, 'system');
  assert.equal(batch.items[6].status, 'retained');
  assert.deepEqual(batch.items.slice(0, 6).map((i: any) => i.login), ['alice', 'bob', 'alice', 'alice', 'bob', 'alice']);
  s.config.automaticAssignment = true; await s.recover();
  assert.deepEqual(s.writes, []); assert.deepEqual(s.dispatches, []);
  assert.equal((await s.prepare()).id, batch.id);
});

test('owner edits, preview revision and full preflight fence the one-off execution', async () => {
  const s = await fixture(); let b = await s.prepare(); const initial = b;
  await assert.rejects(s.call('editAssignmentBatch', { id: b.id, expectedRevision: b.revision, issueId: 'issue-1', repo: 'fixture/repo', login: 'mallory', included: true }), /成员|member/);
  await assert.rejects(s.call('editAssignmentBatch', { id: b.id, expectedRevision: b.revision, issueId: 'issue-1', repo: 'fixture/repo', login: 'bob', included: true }, 'stranger'), /owner|主人/);
  b = await s.call('editAssignmentBatch', { id: b.id, expectedRevision: b.revision, issueId: 'issue-1', repo: 'fixture/repo', login: 'bob', included: true });
  await assert.rejects(s.call('confirmAssignmentBatch', { id: b.id, expectedRevision: initial.revision }), /revision|版本/);
  s.issues[2].assignees = ['alice'];
  await assert.rejects(s.call('confirmAssignmentBatch', { id: b.id, expectedRevision: b.revision }), /变化|changed|负责人/);
  assert.deepEqual(s.writes, []);
  b = await s.call('refreshAssignmentBatch', { id: b.id, expectedRevision: b.revision });
  assert.equal(b.items[0].login, 'bob'); assert.equal(b.items[2].status, 'retained');
  await s.call('confirmAssignmentBatch', { id: b.id, expectedRevision: b.revision });
  await s.recover(); await s.restart(); await s.recover();
  const done = await s.call('getAssignmentBatch', { id: b.id });
  assert.equal(done.status, 'completed'); assert.deepEqual(s.writes, ['bob', 'alice']);
  assert.ok(s.dispatches.every(d => d.initiator === 'system' && !d.acceptanceSuggestedFor));
  await s.call('confirmAssignmentBatch', { id: b.id, expectedRevision: b.revision });
  assert.deepEqual(s.writes, ['bob', 'alice']);
});

test('missing classification can be analyzed without dispatch even when automatic assignment is enabled', async () => {
  const s = await fixture(1, false); let b = await s.prepare();
  assert.equal(b.items[0].status, 'needs-analysis');
  s.config.automaticAssignment = true;
  b = await s.call('analyzeAssignmentBatch', { id: b.id, expectedRevision: b.revision, catId: 'analyst' });
  await s.recover();
  const job = Object.values(await s.context.storage.list()).map(e => e.value as any).find(v => v.kind === 'analysis');
  assert.ok(job.assignmentBatchId); await s.submit(job.id); await s.recover();
  b = await s.call('getAssignmentBatch', { id: b.id });
  assert.equal(b.status, 'draft'); assert.equal(b.items[0].status, 'ready');
  assert.deepEqual(s.writes, []); assert.deepEqual(s.dispatches, []);
});

test('policy/source changes reject the entire confirmation, and partial catalogs never become a plan', async () => {
  for (const change of ['source', 'policy']) {
    const s = await fixture(2); const b = await s.prepare();
    if (change === 'source') s.issues[1].body += ' changed'; else s.members.splice(0, 1);
    await assert.rejects(s.call('confirmAssignmentBatch', { id: b.id, expectedRevision: b.revision }));
    assert.deepEqual(s.writes, []);
  }
  const s = await fixture(); s.provider.openIssues = async () => { throw new Error('partial catalog'); };
  await assert.rejects(s.prepare(), /partial/);
  assert.equal(await s.call('getAssignmentBatch', {}), null);
});

for (const delivery of ['assignment', 'invitation']) test(`uncertain ${delivery} publication is not duplicated, and a partial batch resumes only on explicit confirmation`, async () => {
  const s = await fixture(2); s.config.dispatchMode = delivery; if (delivery === 'invitation') s.login('bob'); let b = await s.prepare(); const publish = s.provider.publishDispatch; let attempts = 0;
  s.provider.publishDispatch = async (...args) => { attempts++; const result = await publish(...args); if (attempts === 1) throw new Error('lost response'); return result; };
  await s.call('confirmAssignmentBatch', { id: b.id, expectedRevision: b.revision }); await s.recover();
  b = await s.call('getAssignmentBatch', { id: b.id }); assert.equal(b.status, 'partial');
  const writes = [...s.writes]; await s.restart(); await s.recover(); assert.deepEqual(s.writes, writes);
  await s.call('retryAssignmentBatch', { id: b.id, expectedRevision: b.revision }); await s.recover();
  b = await s.call('getAssignmentBatch', { id: b.id }); assert.equal(b.status, 'completed');
  assert.equal(s.writes.length, delivery === 'invitation' ? 0 : 2); assert.equal(s.dispatches.length, 2);
});

test('stopping a reviewed snapshot cannot release skipped issues to the background dispatcher', async () => {
  const s = await fixture(1); const b = await s.prepare();
  await s.call('cancelAssignmentBatch', { id: b.id, expectedRevision: b.revision });
  s.config.automaticAssignment = true; await s.recover();
  assert.deepEqual(s.writes, []); assert.deepEqual(s.dispatches, []);
});

test('batch details and receiver notifications suppress reporter acceptance suggestions', async () => {
  const s = await fixture(1, true, true); const b = await s.prepare();
  await s.call('confirmAssignmentBatch', { id: b.id, expectedRevision: b.revision }); await s.recover();
  const done = await s.call('getAssignmentBatch', { id: b.id });
  const detail = await s.call('get', { id: done.items[0].recordId });
  assert.equal(detail.assignmentOptions.acceptanceSuggestedFor, undefined);
  s.login('alice'); await s.recover();
  const inbox = Object.values(await s.context.storage.list()).map(e => e.value as any).find(v => v.kind === 'inbox');
  assert.equal(inbox.initiator, 'system');
  assert.equal((await s.call('get', { id: inbox.id })).assignmentOptions.acceptanceSuggestedFor, undefined);
  assert.ok([...s.sends.values()].every(s => !JSON.stringify(s).includes('建议合入前邀请')));
});

test('large previews share one fresh roster read; preflight uses complete catalogs instead of per-issue network reads', async () => {
  const s = await fixture(280); let rosters = 0, reads = 0, lists = 0;
  const list = s.context.storage.list; s.context.storage.list = async () => { lists++; return list(); };
  const group = s.provider.organizationMembers, issue = s.provider.issue;
  s.provider.organizationMembers = async (...args) => { rosters++; return group(...args); };
  s.provider.issue = async (...args) => { reads++; return issue(...args); };
  let b = await s.prepare(); assert.equal(rosters, 1); assert.equal(b.items.length, 280);
  assert.ok(lists <= 3, `complete persisted state must not be transferred per issue: ${lists}`);
  b = await s.call('refreshAssignmentBatch', { id: b.id, expectedRevision: b.revision });
  assert.equal(reads, 0, 'refresh also reads a complete catalog rather than one subprocess per issue');
  await s.call('confirmAssignmentBatch', { id: b.id, expectedRevision: b.revision });
  assert.equal(rosters, 3); assert.equal(reads, 0); assert.deepEqual(s.writes, []);
});

test('permission preflight checks all selected recipients before any GitHub write', async () => {
  const s = await fixture(2); const b = await s.prepare(); s.provider.assignable = async (_repo, login) => login !== 'bob';
  await assert.rejects(s.call('confirmAssignmentBatch', { id: b.id, expectedRevision: b.revision }), /bob/);
  assert.deepEqual(s.writes, []);
});

test('upgrade retains an earlier unnormalized preview and rewrites it only on a new owner action', async () => {
  const s = await fixture(2); const batch = await s.prepare();
  const { revision: _revision, delivery: _delivery, ...legacy } = batch;
  await s.context.storage.set('issue-workbench.assignment-batch.v1.' + batch.id, legacy);
  await s.restart(); const restored = await s.call('getAssignmentBatch', { id: batch.id });
  assert.deepEqual(restored.items, batch.items); assert.equal(restored.delivery, undefined); assert.deepEqual(s.writes, []);
  const refreshed = await s.call('refreshAssignmentBatch', { id: batch.id, expectedRevision: restored.revision });
  assert.equal(refreshed.id, batch.id); assert.equal(refreshed.status, 'draft');
  const stored = await s.context.storage.get('issue-workbench.assignment-batch.v1.' + batch.id);
  assert.ok(Array.isArray((stored!.value as any).options));
});

test('an invitation batch uses member authority, sends system invitations and restores without assigning or duplicating', async () => {
  const s = await fixture(2); s.config.dispatchMode = 'invitation'; s.login('bob');
  s.provider.assignable = async () => { throw new Error('Invitations do not require assignee permission'); };
  const b = await s.prepare(); assert.equal(b.delivery, 'invitation');
  await s.call('confirmAssignmentBatch', { id: b.id, expectedRevision: b.revision });
  await s.recover(); await s.restart(); await s.recover();
  const done = await s.call('getAssignmentBatch', { id: b.id });
  assert.equal(done.status, 'completed'); assert.deepEqual(done.items.map((i: any) => i.status), ['invited', 'invited']);
  assert.deepEqual(s.writes, []); assert.equal(s.dispatches.length, 2);
  assert.ok(s.dispatches.every(d => d.delivery === 'invitation' && d.initiator === 'system' && !d.acceptanceSuggestedFor));
  await s.call('confirmAssignmentBatch', { id: b.id, expectedRevision: b.revision });
  await s.recover(); assert.equal(s.dispatches.length, 2);
});

test('invitation batches reject sender revocation and delivery changes before confirmation or execution', async () => {
  for (const change of ['sender', 'before-confirm', 'after-confirm']) {
    const s = await fixture(2); s.config.dispatchMode = 'invitation'; s.login('bob'); const b = await s.prepare();
    if (change === 'after-confirm') await s.call('confirmAssignmentBatch', { id: b.id, expectedRevision: b.revision });
    if (change === 'sender') s.login('outsider'); else s.config.dispatchMode = 'assignment';
    if (change !== 'after-confirm') await assert.rejects(s.call('confirmAssignmentBatch', { id: b.id, expectedRevision: b.revision }));
    else { await s.recover(); assert.equal((await s.call('getAssignmentBatch', { id: b.id })).status, 'partial'); }
    assert.deepEqual(s.writes, []); assert.deepEqual(s.dispatches, []);
  }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import type { ModulePluginHostShape, PluginOwnerOperationContext } from '@clowder-ai/plugin-sdk';
import { createIssueTeamModule } from '../src/team/plugin-entrypoint.js';
import { setup } from './helpers/team-fixture.js';

test('a native invocation that expires during GitHub permission checks cannot assign or publish', async () => {
  const s = setup(), runtime = s.runtime();
  const job = await runtime.invoke('analyze', { repo: 'fixture/repo', number: 1, requestId: 'authority' }, s.caller('requester')) as any;
  let current = true;
  s.provider.assignable = async () => { current = false; return true; };
  const caller = { ...s.caller(), assertCurrent: async () => { if (!current) throw new Error('Invocation expired'); } };
  await assert.rejects(runtime.invoke('submit', { id: job.id, analysis: s.analysis }, caller), /expired/);
  assert.deepEqual(s.writes, []);
  assert.deepEqual(s.dispatches, []);
  // One expired call must not poison a later authorized invocation.
  const row = await runtime.invoke('get', { id: job.id }, s.caller()) as any;
  assert.equal(row.analysis.score, 9);
});

test('a native read expiring during source retrieval does not disclose the result', async () => {
  const s = setup(), runtime = s.runtime();
  let current = true;
  const issue = s.provider.issue;
  s.provider.issue = async (...args) => { const value = await issue(...args); current = false; return value; };
  const caller = { ...s.caller(), assertCurrent: async () => { if (!current) throw new Error('Invocation expired'); } };
  await assert.rejects(runtime.invoke('inspect', { repo: 'fixture/repo', number: 1 }, caller), /expired/);
});

test('authority expiry during the final group refresh cannot leak an assignment', async () => {
  const s = setup(), runtime = s.runtime();
  const job = await runtime.invoke('analyze', { repo: 'fixture/repo', number: 1, requestId: 'group-refresh' }, s.caller('requester')) as any;
  let current = true, checkedPermission = false;
  s.provider.assignable = async () => { checkedPermission = true; return true; };
  const get = s.context.config.get;
  s.context.config.get = async key => {
    const value = await get(key);
    if (checkedPermission && key === 'teamOrganization') current = false;
    return value;
  };
  const caller = { ...s.caller(), assertCurrent: async () => { if (!current) throw new Error('Invocation expired'); } };
  await assert.rejects(runtime.invoke('submit', { id: job.id, analysis: s.analysis }, caller), /expired/);
  assert.deepEqual(s.writes, []);
  assert.deepEqual(s.dispatches, []);
});

test('record details are reauthorized after reading shared receipts', async () => {
  const s = setup(), runtime = s.runtime();
  const job = await runtime.invoke('analyze', { repo: 'fixture/repo', number: 1, requestId: 'detail' }, s.caller('requester')) as any;
  let current = true;
  s.provider.receipts = async () => { current = false; return []; };
  const caller = { ...s.caller(), assertCurrent: async () => { if (!current) throw new Error('Invocation expired'); } };
  await assert.rejects(runtime.invoke('get', { id: job.id }, caller), /expired/);
});

test('a receiver invocation expiring while saving its intent cannot publish a public receipt', async () => {
  const s = setup(), runtime = s.runtime();
  s.login('alice'); s.issues[0].assignees = ['alice']; s.config.shareProgress = true;
  const rows = await runtime.invoke('receive', {}, s.caller('receiver', 'inbox')) as any[];
  let current = true, publications = 0;
  const save = s.context.storage.compareAndSet;
  s.context.storage.compareAndSet = async (...args) => { const saved = await save(...args); current = false; return saved; };
  s.provider.publishReceipt = async () => { publications++; return 'unexpected-comment'; };
  const caller = { ...s.caller('receiver', 'inbox'), assertCurrent: async () => { if (!current) throw new Error('Invocation expired'); } };
  await assert.rejects(runtime.invoke('report', {
    id: rows[0].id, status: 'accepted', summary: 'Taking this issue', evidenceUrls: [],
  }, caller), /expired/);
  assert.equal(publications, 0);
});

test('Settings retry retains its owner authority throughout recovery without poisoning scheduled recovery', async () => {
  const s = setup();
  s.config.automaticAssignment = false;
  const manifest = parse(readFileSync(new URL('../plugin.yaml', import.meta.url), 'utf8'));
  const host = { ...s.context, dataPath: '/isolated-test', secrets: { get: async () => undefined },
    messaging: { ...s.context.messaging, send: ({ threadId, ...draft }) => s.context.messaging.send(threadId, draft) },
  } as ModulePluginHostShape;
  const active = await createIssueTeamModule(s.provider).create(manifest).start(host);
  try {
    const job = (await active.actions['issue.team.analyze']!(
      { repo: 'fixture/repo', number: 1, requestId: 'owner-retry' }, s.caller('requester'),
    ) as any).data;
    await active.actions['issue.team.submit']!({ id: job.id, analysis: s.analysis }, s.caller());
    s.config.automaticAssignment = true;
    let current = true;
    s.provider.assignable = async () => { current = false; return true; };
    const owner: PluginOwnerOperationContext = {
      kind: 'owner-operation', userId: 'owner', pluginInstanceId: 'isolated-test',
      operationKey: 'teamStatus', actionId: 'retry', requestId: 'retry-expiry',
      signal: new AbortController().signal,
      assertCurrent: async () => { if (!current) throw new Error('Owner request expired'); },
    };
    await assert.rejects(active.actions['issue.team.retry']!({}, undefined, owner), /expired/);
    assert.deepEqual(s.writes, []);
    assert.deepEqual(s.dispatches, []);
    s.provider.assignable = async () => true;
    await active.actions['issue.team.poll']!({});
    assert.deepEqual(s.writes, ['alice'], 'the saved automatic policy still authorizes a fresh scheduled run');
  } finally { await active.stop(); }
});

test('plugin-delivered analysis uses its verified invocation origin without a wait-source projection', async () => {
  const s = setup(); s.config.automaticAssignment = false;
  const runtime = s.runtime();
  const job = await runtime.invoke('analyze', { repo: 'fixture/repo', number: 1, requestId: 'native-origin' }, s.caller('requester')) as any;
  const caller = { ...s.caller(), source: undefined, originTriggerMessageId: job.messageId };
  const detail = await runtime.invoke('get', { id: job.id }, caller) as any;
  assert.equal(detail.id, job.id);
  const result = await runtime.invoke('submit', { id: job.id, analysis: s.analysis }, caller) as any;
  assert.equal(result.status, 'analyzed');
  assert.equal(result.provenance.sourceMessageId, job.messageId);
  assert.equal(result.provenance.invocationId, caller.invocationId);
  assert.deepEqual(s.writes, []);
  assert.deepEqual(s.dispatches, []);
});

test('missing wait-source cannot authorize another origin, owner feedback, or a new request', async () => {
  const s = setup(); s.config.automaticAssignment = false;
  const runtime = s.runtime();
  const job = await runtime.invoke('analyze', { repo: 'fixture/repo', number: 1, requestId: 'native-origin-denial' }, s.caller('requester')) as any;
  const caller = { ...s.caller(), source: undefined, originTriggerMessageId: 'unrelated-message' };
  await assert.rejects(runtime.invoke('submit', { id: job.id, analysis: s.analysis }, caller), /origin|source/i);
  await assert.rejects(runtime.invoke('analyze', { repo: 'fixture/repo', number: 1, requestId: 'invented-request' }, caller), /source/i);
  await assert.rejects(runtime.invoke('feedback', { id: job.id, verdict: 'accepted', reason: 'not owner authority' }, caller), /source|owner/i);
  await assert.rejects(runtime.invoke('get', { id: job.id }), /caller/i);
  await assert.rejects(runtime.invoke('get', { id: job.id }, { ...caller, assertCurrent: async () => { throw new Error('expired'); } }), /expired/);
  assert.equal((await runtime.invoke('get', { id: job.id }, s.caller()) as any).analysis, undefined);
});

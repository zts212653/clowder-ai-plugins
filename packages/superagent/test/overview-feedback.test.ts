import assert from 'node:assert/strict';
import test from 'node:test';
import { overviewSchema } from '../src/overview.js';
import { startSuperagent } from '../src/runtime.js';
import { runtimeSchema } from '../src/state.js';
import { fixture } from './fixture.js';

test('an open Task returns a correctable overview result and the same request can publish without closing it', async () => {
  const f = fixture();
  await f.host.storage.set('preferences', { ...f.preferences, started: true });
  f.tasks.set('task-a', { id: 'task-a', threadId: 'source-a', status: 'doing', kind: 'work', subjectKey: null, title: 'Awaiting acceptance', ownerCatId: 'original-owner', why: 'Fix export', createdBy: 'owner', createdAt: 1, updatedAt: 1, userId: 'owner', entrustedWork: { revision: 3, closure: { state: 'open' }, admission: { sourceRefs: ['message:owner'] } } });
  const original = structuredClone([...f.tasks.values()]);
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.tick']({});
  const state = runtimeSchema.parse(f.rows.get('runtime')?.value);
  const overview = overviewSchema.parse(f.rows.get('overview')?.value);
  const rows = [
    { threadId: 'source-a', status: 'done', progress: 'Installed', blocker: '', nextStep: 'Check experience', evidenceIds: ['task-a'] },
    { threadId: 'source-b', status: 'unknown', progress: 'Unverified', blocker: '', nextStep: 'Continue in source', evidenceIds: [] },
  ];
  const rejected = await runtime.actions['superagent.overview']({ kind: 'publish', requestId: overview.requestId, rows }, f.caller(state.coordinationThreadId!));
  assert.deepEqual(rejected, { ok: false, errorCode: 'task_open', message: '正式任务尚未闭合，不能把回复结束当作已完成', threadId: 'source-a', openTaskIds: ['task-a'] });
  assert.deepEqual([...f.tasks.values()], original);
  assert.equal([...f.sent.values()].filter(message => message.threadId === state.mainThreadId && JSON.stringify(message.payload).includes('监听会话总览')).length, 0);
  const corrected = rows.map(row => row.threadId === 'source-a' ? { ...row, status: 'doing' } : row);
  const published = await runtime.actions['superagent.overview']({ kind: 'publish', requestId: overview.requestId, rows: corrected }, f.caller(state.coordinationThreadId!));
  assert.equal(overviewSchema.parse(published).phase, 'done');
  assert.deepEqual([...f.tasks.values()], original);
  const repeated = await runtime.actions['superagent.overview']({ kind: 'publish', requestId: overview.requestId, rows: corrected.map(row => ({ ...row, progress: 'Different' })) }, f.caller(state.coordinationThreadId!)) as { errorCode: string };
  assert.equal(repeated.errorCode, 'already_published');
  assert.equal([...f.sent.values()].filter(message => message.threadId === state.mainThreadId && JSON.stringify(message.payload).includes('监听会话总览')).length, 1);
  await runtime.stop({ reason: 'test' });
});

test('stale scope, coverage and evidence failures expose correction coordinates while caller authority still rejects', async () => {
  const f = fixture();
  await f.host.storage.set('preferences', { ...f.preferences, started: true });
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.tick']({});
  const state = runtimeSchema.parse(f.rows.get('runtime')?.value);
  const overview = overviewSchema.parse(f.rows.get('overview')?.value);
  const rows = f.preferences.threadIds.map(threadId => ({ threadId, status: 'unknown', progress: 'Unverified', blocker: '', nextStep: 'Continue in source', evidenceIds: [] as string[] }));
  const call = (requestId: string, submitted: typeof rows) => runtime.actions['superagent.overview']({ kind: 'publish', requestId, rows: submitted }, f.caller(state.coordinationThreadId!));
  assert.deepEqual(await call('old-request', rows), { ok: false, errorCode: 'request_changed', message: '总览请求已变化，请重新读取 inspect.overview', requestId: overview.requestId });
  const coverage = await call(overview.requestId, rows.slice(0, 1)) as { errorCode: string; expectedSourceIds: string[]; submittedCount: number };
  assert.equal(coverage.errorCode, 'coverage');
  assert.deepEqual(coverage.expectedSourceIds, f.preferences.threadIds);
  assert.equal(coverage.submittedCount, 1);
  const mistyped = rows.map(row => row.threadId === 'source-b' ? { ...row, threadId: 'source-b-typo' } : row);
  const sameCount = await call(overview.requestId, mistyped) as { expectedSourceIds: string[]; submittedSourceIds: string[]; submittedCount: number };
  assert.equal(sameCount.submittedCount, sameCount.expectedSourceIds.length);
  assert.equal(new Set(sameCount.submittedSourceIds).size, sameCount.expectedSourceIds.length);
  assert.deepEqual(sameCount.submittedSourceIds.filter(id => !sameCount.expectedSourceIds.includes(id)), ['source-b-typo']);
  assert.deepEqual(sameCount.expectedSourceIds.filter(id => !sameCount.submittedSourceIds.includes(id)), ['source-b']);
  const evidence = await call(overview.requestId, rows.map(row => ({ ...row, evidenceIds: ['invented'] }))) as { errorCode: string; threadId: string; allowedEvidenceIds: string[] };
  assert.equal(evidence.errorCode, 'evidence');
  assert.equal(evidence.threadId, 'source-a');
  assert.deepEqual(evidence.allowedEvidenceIds, []);
  await assert.rejects(async () => runtime.actions['superagent.overview']({ kind: 'publish', requestId: overview.requestId, rows }, f.caller('outside', 'worker')), /configured coordinator/);
  assert.equal(overviewSchema.parse(f.rows.get('overview')?.value).phase, 'pending');
  const corrected = mistyped.map(row => ({ ...row, threadId: row.threadId === 'source-b-typo' ? sameCount.expectedSourceIds[1] : row.threadId }));
  assert.equal(overviewSchema.parse(await call(overview.requestId, corrected)).phase, 'done');
  await runtime.stop({ reason: 'test' });
});

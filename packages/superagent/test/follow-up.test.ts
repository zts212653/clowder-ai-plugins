import assert from 'node:assert/strict';
import test from 'node:test';
import { overviewSchema } from '../src/overview.js';
import { startSuperagent } from '../src/runtime.js';
import { inboxSchema, runtimeSchema } from '../src/state.js';
import { event, fixture } from './fixture.js';

test('a global overview retains doing tasks and no-Task sources without changing ownership or declaring open work complete', async () => {
  const f = fixture();
  await f.host.storage.set('preferences', { ...f.preferences, started: true });
  f.tasks.set('task-a', { id: 'task-a', threadId: 'source-a', status: 'doing', kind: 'work', subjectKey: null, title: '尚未验收', ownerCatId: 'original-owner', why: '修复导出', createdBy: 'owner', createdAt: 1, updatedAt: 1, userId: 'owner', entrustedWork: { revision: 3, closure: { state: 'open' }, admission: { sourceRefs: ['message:owner'] } } });
  const original = structuredClone([...f.tasks.values()]);
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.tick']({});
  const state = runtimeSchema.parse(f.rows.get('runtime')?.value);
  const overview = overviewSchema.parse(f.rows.get('overview')?.value);
  assert.equal(overview.sources.length, 2);
  assert.equal(overview.sources[0].existingWork[0].ownerCatId, 'original-owner');
  const rejected = await runtime.actions['superagent.overview']({ kind: 'publish', requestId: overview.requestId, rows: [
    { threadId: 'source-a', status: 'done', progress: '模型说完成', blocker: '', nextStep: '无需操作', evidenceIds: ['task-a'] },
    { threadId: 'source-b', status: 'unknown', progress: '未核实', blocker: '', nextStep: '回原会话核实', evidenceIds: [] },
  ] }, f.caller(state.coordinationThreadId!)) as { errorCode: string };
  assert.equal(rejected.errorCode, 'task_open');
  assert.deepEqual([...f.tasks.values()], original);
  await runtime.stop({ reason: 'test' });
});

test('changes coalesce for ten minutes; pending requests survive restart and completed-without-summary does not loop', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const f = fixture();
  await f.host.storage.set('preferences', { ...f.preferences, started: true });
  const first = await startSuperagent(f.host);
  await first.actions['superagent.tick']({});
  const state = runtimeSchema.parse(f.rows.get('runtime')?.value);
  const overview = overviewSchema.parse(f.rows.get('overview')?.value);
  const rows = f.preferences.threadIds.map((threadId) => ({ threadId, status: 'unknown', progress: '暂无可确认的进展', blocker: '', nextStep: '需要时回原会话核实', evidenceIds: [] }));
  await first.actions['superagent.overview']({ kind: 'publish', requestId: overview.requestId, rows }, f.caller(state.coordinationThreadId!));
  f.history.set('source-a', [{ id: 'new-progress', content: '正在修复', timestamp: 200_000, sender: { kind: 'cat', catId: 'original-owner' } }]);
  t.mock.timers.setTime(200_000);
  await first.actions['superagent.tick']({});
  assert.equal([...f.sent.values()].filter((message) => message.wake).length, 1);
  t.mock.timers.setTime(701_000);
  await first.actions['superagent.tick']({});
  const secondRequest = overviewSchema.parse(f.rows.get('overview')?.value);
  assert.notEqual(secondRequest.requestId, overview.requestId);
  await first.stop({ reason: 'restart' });
  const second = await startSuperagent(f.host);
  await second.actions['superagent.tick']({});
  assert.equal([...f.sent.values()].filter((message) => message.wake).length, 2);
  f.history.set(state.coordinationThreadId!, [{ id: 'no-summary', timestamp: 701_001, content: '已查看', sender: { kind: 'cat', catId: 'coordinator' }, response: { executionId: 'second', inputMessageIds: [secondRequest.wakeMessageId!], status: 'completed', startedAt: 701_000, completedAt: 701_001 } }]);
  t.mock.timers.setTime(800_000);
  await second.actions['superagent.tick']({});
  assert.equal(overviewSchema.parse(f.rows.get('overview')?.value).phase, 'failed');
  t.mock.timers.setTime(2_000_000);
  await second.actions['superagent.tick']({});
  assert.equal([...f.sent.values()].filter((message) => message.wake).length, 2, 'no automatic paid retry');
  await assert.rejects(async () => second.actions['superagent.overview']({ kind: 'refresh' }, f.caller('outside')), /coordinator/);
  await second.actions['superagent.overview']({ kind: 'refresh' }, f.caller(state.mainThreadId!));
  assert.equal([...f.sent.values()].filter((message) => message.wake).length, 3);
  await second.stop({ reason: 'test' });
});

test('a failed old judgment is retained without blocking a new conversation event or retrying it automatically', async () => {
  const f = fixture();
  await f.seed();
  await f.host.storage.set('inbox:old-failure', { delivery: event('old-failure'), phase: 'failed', receivedAt: 1 });
  await f.host.storage.set('queue', { inbox: ['old-failure'] });
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.observe'](event('new-completion', 'source-b', '导出修复已经完成。'));
  await runtime.actions['superagent.tick']({});
  const wakes = [...f.sent.values()].filter((item) => item.wake);
  assert.equal(wakes.length, 1);
  assert.match(JSON.stringify(wakes[0].payload), /new-completion/);
  assert.equal(inboxSchema.parse(f.rows.get('inbox:old-failure')?.value).phase, 'failed');
  assert.equal(inboxSchema.parse(f.rows.get('inbox:old-failure')?.value).attempt, 0);
  await runtime.stop({ reason: 'test' });
});

test('a scope change refreshes all sources even while the previous snapshot was pending', async () => {
  const f = fixture();
  await f.host.storage.set('preferences', { ...f.preferences, started: true });
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.tick']({});
  const original = overviewSchema.parse(f.rows.get('overview')?.value);
  await f.host.storage.set('preferences', { ...f.preferences, started: true, threadIds: ['source-b'] });
  await runtime.actions['superagent.overview']({ kind: 'refresh' }, f.caller(runtimeSchema.parse(f.rows.get('runtime')?.value).mainThreadId!));
  const next = overviewSchema.parse(f.rows.get('overview')?.value);
  assert.deepEqual(next.sources.map((source) => source.threadId), ['source-b']);
  assert.notEqual(original.requestId, next.requestId);
  await runtime.stop({ reason: 'test' });
});

test('overview stays paused with intake and does not create work or call a model', async () => {
  const f = fixture();
  await f.host.storage.set('preferences', { ...f.preferences, enabled: false, started: true });
  f.host.tasks.list = async () => { throw new Error('paused code must not read tasks'); };
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.tick']({});
  assert.equal(f.rows.has('overview'), false);
  assert.equal([...f.sent.values()].filter((message) => message.wake).length, 0);
  await runtime.stop({ reason: 'test' });
});

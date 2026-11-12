import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginTaskStatus } from '@clowder-ai/plugin-sdk';
import { startSuperagent } from '../src/runtime.js';
import { inboxSchema } from '../src/state.js';
import { event, fixture } from './fixture.js';

function task(id: string, threadId: string, status: PluginTaskStatus) {
  return {
    id, threadId, status, kind: 'work' as const, subjectKey: null,
    title: id, ownerCatId: 'existing-owner', why: '', createdBy: 'owner',
    createdAt: 1, updatedAt: 1, userId: 'owner',
  };
}

test('existing completed and blocked work in selected conversations is reported without taking over or waking a model', async () => {
  const f = fixture();
  await f.seed();
  f.tasks.set('导出修复', task('导出修复', 'source-a', 'done'));
  f.tasks.set('发布等待批准', task('发布等待批准', 'source-b', 'blocked'));
  f.tasks.set('范围外的工作', task('范围外的工作', 'outside', 'done'));
  const original = structuredClone([...f.tasks.values()]);
  const reads: string[] = [];
  f.host.tasks.list = async (filter) => {
    assert.ok(filter.threadId, 'follow-up must read only exact selected conversations');
    reads.push(filter.threadId);
    return [...f.tasks.values()].filter((item) => item.threadId === filter.threadId);
  };
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.tick']({});
  const notices = [...f.sent.values()].filter((item) => JSON.stringify(item.payload).includes('导出修复'));
  assert.equal(notices.length, 1, 'existing completion must be visible before a new source message arrives');
  const content = JSON.stringify(notices[0].payload);
  assert.match(content, /已完成/);
  assert.match(content, /发布等待批准/);
  assert.doesNotMatch(content, /范围外|早上好|想让我|先做哪/);
  assert.equal(notices[0].wake, undefined);
  assert.deepEqual([...f.tasks.values()], original, 'read-only follow-up must retain canonical ownership and status');
  assert.deepEqual(new Set(reads), new Set(['source-a', 'source-b']));
  const inspected = await runtime.actions['superagent.inspect']({}, f.caller(notices[0].threadId));
  assert.match(JSON.stringify(inspected), /导出修复/);
  await runtime.stop({ reason: 'test' });
});

test('completion changes are reported once across quiet checks and restart; ordinary progress stays quiet', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const f = fixture();
  await f.seed();
  f.tasks.set('导出修复', task('导出修复', 'source-a', 'doing'));
  f.host.tasks.list = async ({ threadId }) => [...f.tasks.values()].filter((item) => item.threadId === threadId);
  const first = await startSuperagent(f.host);
  await first.actions['superagent.tick']({});
  assert.equal(f.sent.size, 1, 'ongoing work does not create another readiness or progress message');
  f.tasks.set('导出修复', { ...f.tasks.get('导出修复')!, status: 'done', updatedAt: 110_000 });
  t.mock.timers.setTime(161_000);
  await first.actions['superagent.tick']({});
  assert.equal([...f.sent.values()].filter((item) => JSON.stringify(item.payload).includes('导出修复')).length, 1);
  t.mock.timers.setTime(222_000);
  await first.actions['superagent.tick']({});
  await first.stop({ reason: 'restart' });
  const second = await startSuperagent(f.host);
  t.mock.timers.setTime(283_000);
  await second.actions['superagent.tick']({});
  assert.equal([...f.sent.values()].filter((item) => JSON.stringify(item.payload).includes('导出修复')).length, 1);
  assert.equal([...f.sent.values()].filter((item) => item.wake).length, 0);
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
  assert.equal(wakes.length, 1, 'one failed judgment must not stop every other conversation');
  assert.match(JSON.stringify(wakes[0].payload), /new-completion/);
  assert.doesNotMatch(JSON.stringify(wakes[0].payload), /old-failure/);
  assert.equal(inboxSchema.parse(f.rows.get('inbox:old-failure')?.value).phase, 'failed');
  assert.equal(inboxSchema.parse(f.rows.get('inbox:old-failure')?.value).attempt, 0);
  await runtime.stop({ reason: 'test' });
});

test('an open entrusted closure is not completed merely because a legacy status or model turn ended', async () => {
  const f = fixture();
  await f.seed();
  f.tasks.set('尚未验收', {
    ...task('尚未验收', 'source-a', 'done'),
    entrustedWork: { revision: 3, closure: { state: 'open' }, admission: { sourceRefs: ['message:original-owner'] } },
  });
  f.host.tasks.list = async ({ threadId }) => [...f.tasks.values()].filter((item) => item.threadId === threadId);
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.tick']({});
  assert.equal(f.sent.size, 1, 'authoritative closure must win over legacy done');
  assert.equal(f.tasks.get('尚未验收')?.entrustedWork?.closure.state, 'open');
  await runtime.stop({ reason: 'test' });
});

test('a baseline is one compact digest with explicit remaining coverage, not one message for every old task', async () => {
  const f = fixture();
  await f.seed();
  ['A', 'B', 'C', 'D', 'E'].forEach((id) => f.tasks.set(id, task(id, 'source-a', 'done')));
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.tick']({});
  const notices = [...f.sent.values()].filter((item) => JSON.stringify(item.payload).includes('进展更新'));
  assert.equal(notices.length, 1);
  const text = JSON.stringify(notices[0].payload);
  assert.match(text, /已完成 5 项/);
  assert.equal((text.match(/http:\/\/localhost/g) ?? []).length, 3);
  assert.match(text, /另有 2 项/);
  assert.equal(notices[0].wake, undefined);
  await runtime.stop({ reason: 'test' });
});

test('follow-up stays paused with intake and one failed snapshot does not prevent the next intake event', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const f = fixture();
  await f.host.storage.set('preferences', { ...f.preferences, enabled: false, started: true });
  let reads = 0;
  f.host.tasks.list = async () => { reads++; throw new Error('task read changed'); };
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.tick']({});
  assert.equal(reads, 0);
  await f.seed();
  await runtime.actions['superagent.observe'](event('new-after-directory-error'));
  await assert.rejects(async () => runtime.actions['superagent.tick']({}), /task read changed/);
  assert.equal([...f.sent.values()].filter((item) => item.wake).length, 1, 'intake must run before the optional snapshot');
  assert.equal(inboxSchema.parse(f.rows.get('inbox:new-after-directory-error')?.value).phase, 'routed');
  await runtime.stop({ reason: 'test' });
});

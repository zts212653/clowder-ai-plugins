import assert from 'node:assert/strict';
import test from 'node:test';
import { startSuperagent } from '../src/runtime.js';
import { inboxSchema } from '../src/state.js';
import { event, fixture } from './fixture.js';

test('routine member updates are followed by task snapshots without waking a coordinator for every handoff', async () => {
  const f = fixture();
  await f.seed();
  const update = event('review-handoff', 'source-a', '请鲸鲸复审已经实现的修正。');
  update.envelope.actor = { kind: 'cat', id: 'existing-owner' };
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.observe'](update);
  await runtime.actions['superagent.tick']({});
  assert.equal([...f.sent.values()].filter((row) => row.wake).length, 0);
  assert.equal(f.tasks.size, 0);
  await runtime.stop({ reason: 'test' });
});

test('a structured member failure still reaches judgment but cannot authorize a new Work', async () => {
  const f = fixture();
  await f.seed();
  const failure = event('member-failed', 'source-a', 'CLI quota exceeded');
  failure.envelope.actor = { kind: 'cat', id: 'existing-owner' };
  f.history.set('source-a', [{ id: failure.envelope.messageId, timestamp: 2, content: 'CLI quota exceeded', sender: { kind: 'cat', catId: 'existing-owner' }, response: { executionId: 'failed-call', inputMessageIds: ['owner-request'], status: 'failed', startedAt: 1, completedAt: 2 } }]);
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.observe'](failure);
  await runtime.actions['superagent.tick']({});
  const main = [...f.sent.values()].find((row) => row.wake)!.threadId;
  await assert.rejects(async () => runtime.actions['superagent.route']({ eventId: 'member-failed', decisions: [{ kind: 'start', title: '重复派工', outcome: '重新执行原任务', workerId: 'worker' }] }, f.caller(main)), /用户|human/);
  assert.equal(f.rows.has('plan:member-failed'), false, 'a refused source must not persist an executable plan');
  assert.equal(f.tasks.size, 0);
  await runtime.actions['superagent.route']({ eventId: 'member-failed', decisions: [{ kind: 'ask', content: '执行成员额度不足；建议沿原任务换成员继续，是否采用？' }] }, f.caller(main));
  await runtime.actions['superagent.tick']({});
  assert.ok([...f.sent.values()].some((row) => JSON.stringify(row.payload).includes('额度不足')));
  assert.equal(f.tasks.size, 0);
  await runtime.stop({ reason: 'test' });
});

test('retained routine member and system events drain quietly after an upgrade', async () => {
  const f = fixture();
  await f.seed();
  const update = event('retained-handoff');
  update.envelope.actor = { kind: 'cat', id: 'existing-owner' };
  await f.host.storage.set('inbox:retained-handoff', { delivery: update, phase: 'pending', receivedAt: 1 });
  await f.host.storage.set('queue', { inbox: ['retained-handoff'] });
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.tick']({});
  assert.equal([...f.sent.values()].filter((row) => row.wake).length, 0);
  assert.equal(inboxSchema.parse(f.rows.get('inbox:retained-handoff')?.value).phase, 'done');
  const system = event('empty-reflection', [...f.threads.values()].find((row) => row.title === f.preferences.name)!.id);
  system.envelope.actor = { kind: 'system', id: 'owner-ask-check' };
  await runtime.actions['superagent.observe'](system);
  await runtime.actions['superagent.tick']({});
  assert.equal([...f.sent.values()].filter((row) => row.wake).length, 0);
  await runtime.stop({ reason: 'test' });
});

test('an unapplied legacy plan cannot turn a member handoff into a new canonical Task', async () => {
  const f = fixture();
  await f.seed();
  const update = event('legacy-plan');
  update.envelope.actor = { kind: 'cat', id: 'existing-owner' };
  await f.host.storage.set('inbox:legacy-plan', { delivery: update, phase: 'routed', receivedAt: 1 });
  await f.host.storage.set('plan:legacy-plan', { eventId: 'legacy-plan', decisions: [{ kind: 'start', title: '重复派工', outcome: '旧交接已完成', workerId: 'worker' }], applied: false });
  await f.host.storage.set('queue', { inbox: ['legacy-plan'], plans: ['legacy-plan'] });
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.tick']({});
  assert.equal(f.tasks.size, 0);
  assert.equal([...f.threads.values()].filter((row) => row.title === '重复派工').length, 0);
  assert.ok([...f.rows.keys()].some((key) => key.startsWith('refused-start:')), 'the refusal is retained for audit');
  await runtime.stop({ reason: 'test' });
});

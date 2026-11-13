import assert from 'node:assert/strict';
import test from 'node:test';
import { startSuperagent } from '../src/runtime.js';
import { inboxSchema, runtimeSchema } from '../src/state.js';
import { publish } from '../src/work.js';
import { event, fixture } from './fixture.js';

test('cross-conversation judgment and its model reply stay outside the assistant inbox', async () => {
  const f = fixture();
  await f.seed();
  const runtime = await startSuperagent(f.host);
  const main = runtimeSchema.parse(f.rows.get('runtime')?.value).mainThreadId!;
  await runtime.actions['superagent.observe'](event('already-owned'));
  await runtime.actions['superagent.tick']({});
  const wake = [...f.sent.values()].find((message) => message.wake)!;
  assert.notEqual(wake.threadId, main, 'internal event IDs and tool instructions must not be published in the user inbox');
  assert.match(f.threads.get(wake.threadId!)!.title ?? '', /内部协调/);
  const scope = await runtime.actions['superagent.settings']({});
  assert.ok(JSON.stringify(scope).includes(wake.threadId), 'internal coordination is excluded from listened sources');
  await runtime.actions['superagent.route']({ eventId: 'already-owned', decisions: [{ kind: 'ignore', reason: '原负责人已接住' }] }, f.caller(wake.threadId));
  await runtime.actions['superagent.tick']({});
  assert.equal([...f.sent.values()].filter((message) => message.threadId === main).length, 1, 'an ignored event needs no public ACK or model narration');
  await runtime.stop({ reason: 'test' });
});

test('upgrade finishes an in-flight main-thread judgment once and keeps the old failure untouched', async () => {
  const f = fixture();
  await f.seed();
  await f.host.storage.set('runtime', { mainThreadId: 'source-b' });
  await f.host.storage.set('inbox:legacy-active', { delivery: event('legacy-active'), phase: 'routed', wakeMessageId: 'old-wake', receivedAt: 1 });
  await f.host.storage.set('inbox:legacy-failed', { delivery: event('legacy-failed'), phase: 'failed', receivedAt: 2 });
  await f.host.storage.set('queue', { inbox: ['legacy-active', 'legacy-failed'] });
  const runtime = await startSuperagent(f.host);
  const state = runtimeSchema.parse(f.rows.get('runtime')?.value);
  assert.equal(state.mainThreadId, 'source-b');
  assert.ok(state.coordinationThreadId && state.coordinationThreadId !== state.mainThreadId);
  await runtime.actions['superagent.route']({ eventId: 'legacy-active', decisions: [{ kind: 'ignore', reason: '旧调用已经登记' }] }, f.caller('source-b'));
  await runtime.actions['superagent.tick']({});
  assert.equal(inboxSchema.parse((await f.host.storage.get('inbox:legacy-failed'))?.value).phase, 'failed');
  assert.equal([...f.sent.values()].filter((message) => message.wake).length, 0, 'upgrade does not replay old failed model calls');
  await runtime.actions['superagent.observe'](event('new-direct', 'source-b'));
  await runtime.actions['superagent.tick']({});
  await runtime.actions['superagent.route']({ eventId: 'new-direct', decisions: [{ kind: 'ignore', reason: '直接回答已完成' }] }, f.caller('source-b'));
  await runtime.actions['superagent.tick']({});
  assert.equal([...f.sent.values()].filter((message) => message.wake).length, 0, 'a direct user turn reuses its main-thread invocation');
  await runtime.stop({ reason: 'test' });
});

test('a short result requested directly in the inbox still explains the requested action', async () => {
  const f = fixture();
  await publish(f.host, 'source-a', { sourceThreadId: 'source-a', title: '导出修复', outcome: '空文件也能导出' }, 'direct-result', '空文件验证通过。', 'result');
  const text = JSON.stringify(f.sent.get('source-a:direct-result:source')!.payload);
  assert.match(text, /导出修复/);
  assert.match(text, /空文件也能导出/);
  assert.match(text, /下一步.*验收/);
});

test('a result in the assistant identifies the issue, source, background and requested owner action', async () => {
  const f = fixture();
  await f.seed();
  f.threads.set('source-a', { ...f.threads.get('source-a')!, title: 'issue#1973 发送气泡丢失' });
  const runtime = await startSuperagent(f.host);
  const main = runtimeSchema.parse(f.rows.get('runtime')?.value).mainThreadId!;
  await runtime.actions['superagent.observe'](event('new-design'));
  await runtime.actions['superagent.tick']({});
  const control = [...f.sent.values()].find((message) => message.wake)!.threadId;
  await runtime.actions['superagent.route']({ eventId: 'new-design', decisions: [{ kind: 'start', title: '发送回执设计', outcome: '解决发送后看不到气泡的问题', workerId: 'worker' }] }, f.caller(control));
  await runtime.actions['superagent.tick']({});
  const task = [...f.tasks.values()][0];
  await runtime.actions['superagent.report']({ workId: task.id, reportId: 'design', kind: 'result', content: '已补齐发送中、失败重试和断网恢复三种页面。' }, f.caller(task.threadId, 'worker'));
  await runtime.actions['superagent.tick']({});
  const notice = [...f.sent.values()].find((message) => message.threadId === main && JSON.stringify(message.payload).includes('已补齐'))!;
  const text = notice.payload.elements.filter((element) => element.kind === 'text').map((element) => element.payload.text).join('\n');
  for (const expected of ['发送回执设计', 'issue#1973', 'http://localhost/?threadId=source-a', '解决发送后看不到气泡', '下一步', '验收']) assert.ok(text.includes(expected), expected);
  assert.doesNotMatch(text, /eventId|plugin_call|superagent_inspect/);
  assert.equal(notice.wake, undefined);
  await runtime.stop({ reason: 'test' });
});

test('a failed judgment explains which source stopped and where the owner can retry', async () => {
  const f = fixture();
  await f.seed();
  f.threads.set('source-a', { ...f.threads.get('source-a')!, title: 'issue#1973 发送气泡丢失' });
  const runtime = await startSuperagent(f.host);
  const main = runtimeSchema.parse(f.rows.get('runtime')?.value).mainThreadId!;
  await runtime.actions['superagent.observe'](event('failed-design'));
  await runtime.actions['superagent.tick']({});
  const wake = [...f.sent.values()].find((message) => message.wake)!;
  f.history.set(wake.threadId, [{ id: 'failed', timestamp: 2, content: '', sender: { kind: 'cat', catId: 'coordinator' }, response: { executionId: 'execution', inputMessageIds: [wake.messageId], status: 'failed', startedAt: 1, completedAt: 2 } }]);
  await assert.rejects(async () => runtime.actions['superagent.tick']({}), /判断/);
  const notice = [...f.sent.values()].find((message) => message.threadId === main && JSON.stringify(message.payload).includes('重试'))!;
  const text = JSON.stringify(notice.payload);
  assert.match(text, /issue#1973/);
  assert.match(text, /http:\/\/localhost\/\?threadId=source-a/);
  assert.match(text, /下一步/);
  assert.match(text, /恢复处理/);
  assert.equal([...f.sent.values()].filter((message) => message.wake).length, 1);
  await runtime.stop({ reason: 'test' });
});

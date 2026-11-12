import assert from 'node:assert/strict';
import test from 'node:test';
import { publish } from '../src/work.js';
import { startSuperagent } from '../src/runtime.js';
import { event, fixture } from './fixture.js';

test('a long result remains complete at its source while the assistant receives a labelled excerpt and a working source link', async () => {
  const f = fixture();
  const content = '导出修复已完成验证，等待你验收。\n\n' + '详细调查、日志与验证坐标。'.repeat(180);
  await publish(f.host, 'assistant-main', { sourceThreadId: 'source-a' }, 'long-result', content);
  const original = f.sent.get('source-a:long-result:source')!;
  const main = f.sent.get('assistant-main:long-result:main')!;
  assert.ok(JSON.stringify(original.payload).includes(content.replace(/\n/g, '\\n')), 'source keeps the full real result');
  const text = JSON.stringify(main.payload);
  assert.ok(text.length < 600, 'the main inbox must not copy the entire technical report');
  assert.match(text, /原文节选/);
  assert.match(text, /导出修复已完成验证/);
  assert.match(text, /http:\/\/localhost\/\?threadId=source-a/);
  assert.equal(main.wake, undefined);
});

test('a queued report from a legacy non-user admission cannot overwrite a stopped duplicate Task', async () => {
  const f = fixture();
  await f.seed();
  const key = 'a'.repeat(64);
  const task = { id: 'duplicate-task', threadId: 'source-b', subjectKey: `superagent:${f.host.pluginInstanceId}:${key}`, title: '误派任务', kind: 'work' as const, ownerCatId: 'worker', status: 'blocked' as const, why: '重复误派，停止执行，沿原Task继续', createdBy: 'system', createdAt: 1, updatedAt: 2, userId: 'owner', entrustedWork: { revision: 2, closure: { state: 'open' }, admission: { sourceRefs: ['message:handoff'] } } };
  f.tasks.set(task.id, task);
  await f.host.storage.set(`work:${key}`, { key, taskId: task.id, threadId: task.threadId, sourceThreadId: 'source-a', sourceMessageId: 'handoff', workerId: 'worker', title: task.title, outcome: '误派' });
  await f.host.storage.set('report:legacy:result', { workId: task.id, reportId: 'result', kind: 'result', content: '请验收重复交付。'.repeat(200), applied: false, invocationId: 'legacy' });
  await f.host.storage.set('queue', { works: [key], reports: ['legacy:result'] });
  f.messages.set('handoff', { id: 'handoff', threadId: 'source-a', userId: 'owner', catId: 'existing-owner', content: '旧的审查交接', mentions: [], timestamp: 1, sourceRevision: '1' });
  f.host.tasks.get = async () => null; // A stopped/revoked legacy Task may no longer have a package read projection.
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.tick']({});
  assert.deepEqual(f.tasks.get(task.id), task, 'a queued old result must retain the stop instruction');
  assert.equal(f.rows.has('refused-report:legacy:result'), true);
  assert.equal([...f.sent.values()].some((row) => JSON.stringify(row.payload).includes('重复交付')), false);
  await runtime.actions['superagent.tick']({});
  assert.deepEqual(f.tasks.get(task.id), task);
  const stop = event('retained-stop', 'source-b', '重复工作已经停止。');
  stop.envelope.actor = { kind: 'cat', id: 'existing-owner' };
  await runtime.actions['superagent.observe'](stop);
  await runtime.actions['superagent.tick']({});
  assert.equal([...f.sent.values()].filter((row) => row.wake).length, 0, 'a proven invalid legacy Work must not turn its stop receipts into another paid turn');
  await runtime.stop({ reason: 'test' });
});

test('work requested in the main conversation also keeps its full result in the work thread', async () => {
  const f = fixture();
  const content = '修复通过，等待验收。\n\n' + '完整验证材料。'.repeat(180);
  await publish(f.host, 'source-a', { sourceThreadId: 'source-a', threadId: 'source-b' }, 'main-request', content);
  assert.ok(JSON.stringify(f.sent.get('source-b:main-request:details')!.payload).includes(content.replace(/\n/g, '\\n')));
  const main = f.sent.get('source-a:main-request:source')!;
  assert.ok(JSON.stringify(main.payload).length < 600);
  assert.match(JSON.stringify(main.payload), /http:\/\/localhost\/\?threadId=source-b/);
  assert.equal(f.sent.size, 2);
});

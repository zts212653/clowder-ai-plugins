import assert from 'node:assert/strict';
import test from 'node:test';
import { startSuperagent } from '../src/runtime.js';
import { runtimeSchema } from '../src/state.js';
import { overviewSchema, watchedSources } from '../src/overview.js';
import { event, fixture } from './fixture.js';

test('every watched conversation is represented, including no Task and unavailable sources; one issue cannot dominate', async () => {
  const f = fixture();
  await f.host.storage.set('preferences', { ...f.preferences, started: true, threadIds: ['source-a', 'source-b', 'removed'] });
  f.history.set('source-a', [{ id: 'evidence-a', timestamp: 10, content: 'CI 仍失败，负责人正在修复，不需要用户操作。', sender: { kind: 'cat', catId: 'worker' } }]);
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.tick']({});
  const state = runtimeSchema.parse(f.rows.get('runtime')?.value);
  const inspected = await runtime.actions['superagent.inspect']({}, f.caller(state.coordinationThreadId!)) as {
    overview: { requestId: string; sources: { threadId: string; available: boolean; recent: { id: string }[] }[] };
  };
  assert.deepEqual(inspected.overview.sources.map((source) => source.threadId), ['source-a', 'source-b', 'removed']);
  assert.equal(inspected.overview.sources[2].available, false);
  const rows = [
    { threadId: 'source-a', status: 'blocked', progress: '已提交修复，CI 未通过。', blocker: 'CI 失败，原负责人正在修复。', nextStep: '负责人修复后复跑；你暂不需要操作。', evidenceIds: ['evidence-a'] },
    { threadId: 'source-b', status: 'unknown', progress: '近期没有可用于确认进展的消息。', blocker: '', nextStep: '需要时回原会话核实。', evidenceIds: [] },
    { threadId: 'removed', status: 'unknown', progress: '会话当前不可读取。', blocker: '', nextStep: '请在监听范围中核对会话是否仍可访问。', evidenceIds: [] },
  ];
  assert.equal((await runtime.actions['superagent.overview']({ kind: 'publish', requestId: inspected.overview.requestId, rows: rows.slice(0, 1) }, f.caller(state.coordinationThreadId!)) as { errorCode: string }).errorCode, 'coverage');
  assert.equal((await runtime.actions['superagent.overview']({ kind: 'publish', requestId: inspected.overview.requestId, rows: rows.map((row) => ({ ...row, evidenceIds: ['invented'] })) }, f.caller(state.coordinationThreadId!)) as { errorCode: string }).errorCode, 'evidence');
  await runtime.actions['superagent.overview']({ kind: 'publish', requestId: inspected.overview.requestId, rows }, f.caller(state.coordinationThreadId!));
  const digests = [...f.sent.values()].filter((message) => message.threadId === state.mainThreadId && JSON.stringify(message.payload).includes('监听会话总览'));
  assert.equal(digests.length, 1);
  const text = JSON.stringify(digests[0].payload);
  assert.match(text, /3\/3/);
  assert.match(text, /待核实 2/);
  assert.deepEqual(overviewSchema.parse(f.rows.get('overview')?.value).rows?.map(row => row.threadId), ['source-a', 'source-b', 'removed']);
  assert.match(text, /CI 失败/);
  assert.equal(digests[0].wake, undefined);
  assert.equal(f.tasks.size, 0);
  await runtime.actions['superagent.tick']({});
  await runtime.stop({ reason: 'restart' });
  const second = await startSuperagent(f.host);
  await second.actions['superagent.tick']({});
  assert.equal([...f.sent.values()].filter((message) => message.wake).length, 1, 'quiet checks and restart must not repeat a model request');
  await second.stop({ reason: 'test' });
});

test('a legacy work result is grouped under its original watched source; failed reads do not hide other sources', async () => {
  const f = fixture();
  await f.seed();
  f.tasks.set('design', { id: 'design', threadId: 'outside', title: '气泡设计', status: 'blocked', kind: 'work', subjectKey: null, ownerCatId: 'worker', why: '', createdBy: 'owner', createdAt: 1, updatedAt: 1, userId: 'owner' });
  const key = 'b'.repeat(64);
  await f.host.storage.set(`work:${key}`, { key, taskId: 'design', title: '气泡设计', outcome: '设计已回原会话', sourceThreadId: 'source-a', sourceMessageId: 'owner-original', threadId: 'outside', workerId: 'worker' });
  await f.host.storage.set('question:design-result', { id: 'design-result', workId: 'design', sourceThreadId: 'source-a', content: '设计已附到 issue，等待用户验收。', resolved: false });
  await f.host.storage.set('queue', { works: [key], questions: ['design-result'] });
  f.host.threads.readMessages = async (id) => { if (id === 'source-b') throw new Error('source unavailable'); return []; };
  const sources = await watchedSources(f.host, { ...f.preferences, v: 1, started: true });
  assert.deepEqual(sources.map((source) => source.threadId), ['source-a', 'source-b']);
  assert.equal(sources[0].existingWork[0].id, 'design');
  assert.equal(sources[0].projectRef, '/isolated/sample', 'the Host project identity is retained when pinned scope crosses projects');
  assert.match(sources[0].questions[0].content, /等待用户验收/);
  assert.equal(sources[1].available, false);
  assert.equal(sources.length, 2, 'work conversations are not additional watched sources');
});

test('watching an existing issue does not admit a second Work or execution conversation', async () => {
  const f = fixture();
  await f.seed();
  const runtime = await startSuperagent(f.host);
  const state = runtimeSchema.parse(f.rows.get('runtime')?.value);
  const before = f.threads.size;
  f.history.set('source-a', [{ id: 'original-reply', timestamp: 2, content: '已接下设计。', sender: { kind: 'cat', catId: 'coordinator' }, response: { executionId: 'original-invocation', inputMessageIds: ['source-existing-issue'], status: 'processing', startedAt: 1 } }]);
  await runtime.actions['superagent.observe'](event('existing-issue', 'source-a', '你和鲸鲸一起继续气泡设计。'));
  await runtime.actions['superagent.tick']({});
  assert.equal([...f.sent.values()].filter((message) => message.wake).length, 0, 'the original conversation must not cause a second coordination round');
  await f.host.storage.set('inbox:existing-issue', { delivery: event('existing-issue'), phase: 'pending', receivedAt: 1 });
  await assert.rejects(async () => runtime.actions['superagent.route']({ eventId: 'existing-issue', decisions: [{ kind: 'start', title: '气泡设计', outcome: '设计方案', workerId: 'worker' }] }, f.caller(state.coordinationThreadId!)), /原会话|监听/);
  assert.equal(f.threads.size, before);
  assert.equal(f.tasks.size, 0);
  await runtime.stop({ reason: 'test' });
});

test('removing and re-adding a source publishes a new current overview instead of reusing its historical message', async () => {
  const f = fixture();
  await f.host.storage.set('preferences', { ...f.preferences, started: true });
  const runtime = await startSuperagent(f.host);
  const main = runtimeSchema.parse(f.rows.get('runtime')?.value).mainThreadId!;
  for (const ids of [['source-a', 'source-b'], ['source-b'], ['source-a', 'source-b']]) {
    await f.host.storage.set('preferences', { ...f.preferences, started: true, threadIds: ids });
    const request = await runtime.actions['superagent.overview']({ kind: 'refresh' }, f.caller(main)) as { requestId: string };
    await runtime.actions['superagent.overview']({ kind: 'publish', requestId: request.requestId, rows: ids.map((threadId) => ({ threadId, status: 'unknown', progress: '尚无已确认进展', blocker: '', nextStep: '必要时回原会话核实', evidenceIds: [] })) }, f.caller(main));
  }
  const notices = [...f.sent.values()].filter((message) => message.threadId === main && JSON.stringify(message.payload).includes('监听会话总览'));
  assert.equal(notices.length, 3, 'the latest visible message must reflect the restored full scope');
  await runtime.stop({ reason: 'test' });
});

test('an already handled source message stays quiet even when that source has a plugin Work; fresh feedback still follows the same Work', async () => {
  const f = fixture();
  await f.seed();
  const key = 'c'.repeat(64);
  await f.host.storage.set(`work:${key}`, { key, taskId: 'legacy-task', title: '气泡设计', outcome: '设计', sourceThreadId: 'source-a', sourceMessageId: 'owner-original', threadId: 'outside', workerId: 'worker' });
  await f.host.storage.set('queue', { works: [key] });
  const runtime = await startSuperagent(f.host);
  f.history.set('source-a', [{ id: 'original-reply', timestamp: 2, content: '原负责人已接。', sender: { kind: 'cat', catId: 'coordinator' }, response: { executionId: 'original-run', inputMessageIds: ['source-old-handled'], status: 'completed', startedAt: 1, completedAt: 2 } }]);
  await runtime.actions['superagent.observe'](event('old-handled'));
  await runtime.actions['superagent.tick']({});
  assert.equal([...f.sent.values()].filter((message) => message.wake).length, 0);
  await runtime.actions['superagent.observe'](event('fresh-feedback', 'source-a', '原设计还有一个空状态，请沿原工作补上。'));
  await runtime.actions['superagent.tick']({});
  const wakes = [...f.sent.values()].filter((message) => message.wake);
  assert.equal(wakes.length, 1);
  assert.match(JSON.stringify(wakes[0].payload), /fresh-feedback/);
  assert.equal(f.tasks.size, 0, 'feedback intake must not admit a duplicate Task');
  await runtime.stop({ reason: 'test' });
});

test('a multi-member result projected as a user envelope is not a new human commission', async () => {
  const f = fixture();
  await f.seed();
  const input = event('multi-result');
  input.envelope.actor = { kind: 'user', id: 'multi-mention-result' };
  f.messages.set(input.envelope.messageId, { id: input.envelope.messageId, userId: 'owner', threadId: 'source-a', catId: null, content: 'Multi-Mention 结果汇总：原成员已经共同分析。', mentions: [], timestamp: 1, sourceRevision: '1' });
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.observe'](input);
  await runtime.actions['superagent.tick']({});
  assert.equal([...f.sent.values()].filter((message) => message.wake).length, 0);
  assert.equal(f.rows.has('inbox:multi-result'), false);
  await runtime.stop({ reason: 'test' });
});

test('an attention row keeps its subject and issue/PR readable while full background and progress stay available to inspect', async () => {
  const f = fixture();
  f.threads.set('source-a', { ...f.threads.get('source-a')!, title: '消息气泡延迟排查 · Host Issue #1973' });
  f.history.set('source-a', [{ id: 'problem', timestamp: 1, content: '发送后用户气泡暂时不可见，需要检查发送与排队状态。', sender: { kind: 'owner' } }]);
  await f.host.storage.set('preferences', { ...f.preferences, started: true, threadIds: ['source-a'] });
  const runtime = await startSuperagent(f.host);
  await runtime.actions['superagent.tick']({});
  const main = runtimeSchema.parse(f.rows.get('runtime')?.value).mainThreadId!;
  const request = await runtime.actions['superagent.overview']({ kind: 'refresh' }, f.caller(main)) as { requestId: string };
  await runtime.actions['superagent.overview']({ kind: 'publish', requestId: request.requestId, rows: [{
    threadId: 'source-a', status: 'blocked', tracking: 'Host Issue #1973；PR 尚未创建',
    background: '发送消息后气泡暂时不可见，用户无法确认是否已发送。',
    progress: '已确定发送与排队状态的展示方案，尚未开始修改产品代码。',
    blocker: '发送记录与执行队列的关联方式仍待确认。',
    nextStep: '原负责人确认关联方式后实施；你暂不需要操作。', evidenceIds: ['problem'],
  }] }, f.caller(main));
  const digest = [...f.sent.values()].find((message) => message.threadId === main && JSON.stringify(message.payload).includes('监听会话总览'))!;
  const text = JSON.stringify(digest.payload);
  assert.match(text, /\*\*消息气泡延迟排查 · Host Issue #1973\*\*/);
  assert.doesNotMatch(text, /\[消息气泡延迟排查/);
  assert.match(text, /Host Issue #1973；PR 尚未创建/);
  assert.match(text, /发送记录与执行队列/);
  assert.match(text, /你暂不需要操作/);
  const detail = overviewSchema.parse(f.rows.get('overview')?.value).rows![0];
  assert.match(detail.background, /发送消息后气泡暂时不可见/);
  assert.match(detail.progress, /已确定发送与排队状态/);
  await runtime.stop({ reason: 'test' });
});

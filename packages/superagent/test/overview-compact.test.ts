import assert from 'node:assert/strict';
import test from 'node:test';
import { overviewSchema, publishOverview } from '../src/overview.js';
import { fixture } from './fixture.js';

test('a large overview leads with user actions and a bounded attention table; full source detail remains stored', async () => {
  const f = fixture();
  const sources = Array.from({ length: 32 }, (_, i) => ({
    threadId: `topic-${i}`, title: `问题 ${i} 的具体主题`, available: true, lastActiveAt: 1,
    deepLinkUrl: `http://localhost/thread/topic-${i}`,
    recent: [{ id: `evidence-${i}`, timestamp: 1, content: '原始证据', sender: 'cat' }], existingWork: [], questions: [],
  }));
  const rows = sources.map((source, i) => ({
    threadId: source.threadId,
    status: i === 0 ? 'needs_you' as const : i === 1 ? 'waiting_acceptance' as const : i < 10 ? 'blocked' as const : 'doing' as const,
    tracking: `Host Issue #${100 + i} / PR #${200 + i}`,
    background: `完整问题背景 ${i}，只应在详情里出现。`, progress: `具体解决进展 ${i}。`,
    blocker: i >= 2 && i < 10 ? '等维护者批准，原负责人继续跟进。' : '',
    nextStep: i < 2 ? `请你${i === 0 ? '决定是否发布' : '验收修复效果'}。` : '原负责人继续处理；你暂不需要操作。',
    evidenceIds: [`evidence-${i}`],
  }));
  const overview = { formatVersion: 2, requestId: 'compact-request', phase: 'pending', capturedAt: 1, nextCheckAt: 0, nextRequestAt: 0, sources };
  const pref = { ...f.preferences, v: 1 as const, started: true, threadIds: sources.map(source => source.threadId) };
  await f.host.storage.set('overview', overview);
  await publishOverview(f.host, pref, 'main', { kind: 'publish', requestId: overview.requestId, rows });
  const text = [...f.sent.values()].map(message => JSON.stringify(message.payload)).join('\n');
  assert.match(text, /要你处理 2 项/);
  assert.match(text, /重点关注 8 项/);
  assert.match(text, /\| 事项 \| 你要做什么 \|/);
  assert.match(text, /Issue #100 \/ PR #200/);
  assert.match(text, /请你决定是否发布/);
  assert.match(text, /请你验收修复效果/);
  assert.match(text, /另有 5 项受阻/);
  assert.match(text, /进行中 22/);
  assert.doesNotMatch(text, /完整问题背景|问题 10 的具体主题|问题 5 的具体主题/);
  assert.ok(text.indexOf('要你处理') < text.indexOf('重点关注'));
  assert.ok(text.length < 2400, '32 sources must not turn into a full-page per-source report');
  assert.deepEqual(overviewSchema.parse(f.rows.get('overview')?.value).rows, rows, 'all 32 complete rows remain available through inspect');
});

test('blocked-only and all-quiet overviews state that there are no user actions', async () => {
  for (const status of ['blocked', 'quiet'] as const) {
    const f = fixture();
    const source = { threadId: 'source-a', title: '等待审批', available: true, lastActiveAt: 1, recent: [{ id: 'e', timestamp: 1, content: '待审批', sender: 'cat' }], existingWork: [], questions: [] };
    await f.host.storage.set('overview', { formatVersion: 2, requestId: status, phase: 'pending', capturedAt: 1, nextCheckAt: 0, nextRequestAt: 0, sources: [source] });
    await publishOverview(f.host, { ...f.preferences, v: 1, started: true, threadIds: ['source-a'] }, 'main', {
      kind: 'publish', requestId: status, rows: [{ threadId: 'source-a', status, tracking: 'Host #1', background: '背景', progress: '原负责人跟进中', blocker: '等维护者审批', nextStep: '原负责人继续跟进', evidenceIds: ['e'] }],
    });
    const text = JSON.stringify([...f.sent.values()][0].payload);
    assert.match(text, /当前没有需要你处理的事项/);
    assert.doesNotMatch(text, /\| 事项 \| 你要做什么 \|/);
  }
});

test('overflow user actions are counted, table cells stay intact, and an upgrade republishes the new format only once', async () => {
  const f = fixture();
  const sources = Array.from({ length: 4 }, (_, i) => ({ threadId: `action-${i}`, title: `主题 ${i} | [补充]\n第二行`, available: true, lastActiveAt: 1, recent: [{ id: `e-${i}`, timestamp: 1, content: '证据', sender: 'cat' }], existingWork: [], questions: [] }));
  const rows = sources.map((source, i) => ({ threadId: source.threadId, status: 'needs_you' as const, tracking: `Host #${i}`, background: '完整背景', progress: '等待决定', blocker: '', nextStep: '请你决定 A 或 B', evidenceIds: [`e-${i}`] }));
  const pref = { ...f.preferences, v: 1 as const, started: true, threadIds: sources.map(source => source.threadId) };
  await f.host.storage.set('overview-published', rows);
  for (const requestId of ['upgrade', 'same-content']) {
    await f.host.storage.set('overview', { formatVersion: 3, requestId, phase: 'pending', capturedAt: 1, nextCheckAt: 0, nextRequestAt: 0, sources });
    await publishOverview(f.host, pref, 'main', { kind: 'publish', requestId, rows });
  }
  assert.equal(f.sent.size, 1, 'an old published snapshot receives one short-format update, not repeated identical messages');
  const text = JSON.stringify([...f.sent.values()][0].payload);
  assert.match(text, /要你处理 4 项/);
  assert.match(text, /另有 1 项需要你处理/);
  assert.doesNotMatch(text, /主题 3/);
  assert.ok(text.includes('\\\\|'), 'a literal title pipe is escaped inside the table cell');
});

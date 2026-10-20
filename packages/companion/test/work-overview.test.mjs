import assert from 'node:assert/strict';
import test from 'node:test';
import { workOverviewPresentation } from '../src/work-overview.mjs';

const reply = {
  kind: 'work', v: 1, status: 'partial', observedAt: 1_791_461_000_000,
  scope: { kind: 'current-project', label: 'Cat Café' },
  coverage: [
    { source: 'tasks', status: 'available' },
    { source: 'messages', status: 'available' },
    { source: 'artifacts', status: 'partial' },
  ],
  active: [{ entryRef: 'work-one', title: '桌面猫中断后的恢复',
    actor: { catId: 'codex-sol', displayName: '小太阳' }, activity: 'working',
    taskId: 'task-1', homeThreadId: 'thread-1', sourceRef: 'task:task-1', updatedAt: 1_791_460_900_000 }],
  recentDeliveries: [{ entryRef: 'delivery-one', title: '主页北极星稿 1.6',
    taskId: null, homeThreadId: 'thread-1', sourceRef: 'thread:thread-1#message-1', deliveredAt: 1_791_460_800_000,
    artifact: { artifactId: 'artifact-1', version: '1.6', versionState: 'current' } }],
};

test('partial work truth presents only known rows and never fabricates totals', () => {
  assert.deepEqual(workOverviewPresentation(reply), {
    visible: true,
    scopeLabel: '仅当前项目 · Cat Café',
    notice: '仅部分读取',
    active: [{ entryRef: 'work-one', title: '桌面猫中断后的恢复', meta: '小太阳 · 正在工作' }],
    deliveries: [{ entryRef: 'delivery-one', title: '主页北极星稿 1.6', meta: '作品 1.6 · 当前版本' }],
  });
});

test('unknown task owner stays anonymous instead of inventing a cat', () => {
  const anonymous = { ...reply, active: [{ ...reply.active[0], actor: null }] };
  assert.equal(workOverviewPresentation(anonymous).active[0].meta, '正在工作');
});

test('unavailable work truth keeps its honest notice instead of looking like a known empty result', () => {
  assert.deepEqual(workOverviewPresentation({ ...reply, status: 'unavailable', active: [], recentDeliveries: [] }), {
    visible: true, scopeLabel: '', notice: '暂不可用', active: [], deliveries: [],
  });
});

test('partial zero rows still exposes incomplete coverage truth', () => {
  assert.deepEqual(workOverviewPresentation({ ...reply, active: [], recentDeliveries: [] }), {
    visible: true, scopeLabel: '仅当前项目 · Cat Café', notice: '仅部分读取', active: [], deliveries: [],
  });
});

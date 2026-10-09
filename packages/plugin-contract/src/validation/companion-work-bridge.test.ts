import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCompanionCommand, validateCompanionReply } from './companion-bridge.js';

const work = {
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
  recentDeliveries: [{ entryRef: 'delivery-one', title: '主页北极星稿 1.6', taskId: null,
    homeThreadId: 'thread-1', sourceRef: 'thread:thread-1#message-1', deliveredAt: 1_791_460_800_000,
    artifact: { artifactId: 'artifact-1', version: '1.6', versionState: 'current' } }],
};

test('work reads and navigation stay Host-bound', () => {
  assert.equal(validateCompanionCommand({ kind: 'work.read' }), true);
  assert.equal(validateCompanionCommand({ kind: 'work.read', projectPath: '/chosen/by/renderer' }), false);
  assert.equal(validateCompanionCommand({ kind: 'work.open', entryRef: 'work-one' }), true);
  assert.equal(validateCompanionCommand({ kind: 'work.open', entryRef: 'bad/ref' }), false);
  assert.equal(validateCompanionReply(work), true);
  assert.equal(validateCompanionReply({ ...work, active: [{ ...work.active[0], actor: null }] }), true);
  for (const delivery of ['applied', 'queued', 'blocked', 'unconfirmed']) {
    assert.equal(validateCompanionReply({ kind: 'navigation', delivery }), true, delivery);
  }
});

test('work projection cannot fake totals or collapse artifact version into display state', () => {
  assert.equal(validateCompanionReply({ ...work, totalCount: 2 }), false);
  assert.equal(validateCompanionReply({ ...work, recentDeliveries: [{
    ...work.recentDeliveries[0], artifact: { artifactId: 'artifact-1', version: 'current' },
  }] }), false);
  assert.equal(validateCompanionReply({ ...work, coverage: [
    { source: 'tasks', status: 'available' },
    { source: 'tasks', status: 'partial' },
  ] }), false, 'one canonical source cannot claim two coverage states');
  assert.equal(validateCompanionReply({ ...work, coverage: [
    { source: 'tasks', status: 'unavailable' },
    { source: 'messages', status: 'available' },
    { source: 'artifacts', status: 'available' },
  ] }), false, 'an unavailable task source cannot emit active task rows');
  assert.equal(validateCompanionReply({ ...work, recentDeliveries: [{
    ...work.recentDeliveries[0], artifact: { artifactId: 'artifact-1', version: null, versionState: 'current' },
  }] }), false, 'current cannot be claimed without a known artifact version');
});

test('compact size is admitted consistently by the public settings contract', () => {
  assert.equal(validateCompanionCommand({ kind: 'settings.update', field: 'ballSize', value: 43 }), true);
  assert.equal(validateCompanionCommand({ kind: 'settings.update', field: 'ballSize', value: 42 }), false);
});

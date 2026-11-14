import assert from 'node:assert/strict';
import test from 'node:test';
import { overviewSchema, refreshOverview } from '../src/overview.js';
import { fixture } from './fixture.js';

for (const phase of ['pending', 'done', 'failed'] as const) {
  test(`reordering the same pinned scope preserves the ${phase} overview; membership changes still refresh`, async () => {
    const f = fixture();
    const pref = { ...f.preferences, v: 1 as const, started: true, threadIds: ['source-a', 'source-b'] };
    await refreshOverview(f.host, pref, 'coordination');
    const initial = overviewSchema.parse(f.rows.get('overview')?.value);
    await f.host.storage.set('overview', { ...initial, phase, nextCheckAt: 0, nextRequestAt: 0 });
    await refreshOverview(f.host, { ...pref, threadIds: ['source-b', 'source-a'] }, 'coordination');
    assert.equal(overviewSchema.parse(f.rows.get('overview')?.value).requestId, initial.requestId);
    assert.equal([...f.sent.values()].filter(message => message.wake).length, 1, 'activity order must not request another model run');
    await f.host.storage.set('overview', { ...overviewSchema.parse(f.rows.get('overview')?.value), nextCheckAt: 0 });
    await refreshOverview(f.host, { ...pref, threadIds: ['source-b', 'outside'] }, 'coordination');
    assert.notEqual(overviewSchema.parse(f.rows.get('overview')?.value).requestId, initial.requestId);
    assert.equal([...f.sent.values()].filter(message => message.wake).length, 2, 'a real pin/unpin still refreshes');
    assert.equal(f.tasks.size, 0);
  });
}

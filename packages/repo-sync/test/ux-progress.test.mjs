import assert from 'node:assert/strict';
import test from 'node:test';
import { journeyProgress } from '../src/journey-progress.mjs';
import { renderTask } from '../web/operation-view.mjs';
const start = '2026-10-15T00:00:00Z';
test('round total stays unknown before the source set has been frozen', () => {
  assert.deepEqual(
    journeyProgress({
      automation: { startedAt: start, scanned: false, startingDeliveryId: null },
      deliveries: [],
      queue: [{ target: 'partial' }],
    }),
    { completed: 0, total: null },
  );
});
test('created PR or accepted code with pending metadata does not count as a completed delivery', () => {
  const state = {
    automation: { startedAt: start, scanned: true, startingDeliveryId: 'prior' },
    deliveries: [
      { id: 'prior', target: 'A', status: 'COMPLETE', startedAt: '2026-10-14T23:00:00Z' },
      { id: 'next', target: 'B', status: 'CODE_ACCEPTED_PENDING_METADATA', startedAt: start },
    ],
    queue: [{ target: 'B' }, { target: 'C' }],
  };
  assert.deepEqual(journeyProgress(state), { completed: 1, total: 3 });
});
test('legacy run without admission provenance does not invent a total', () => {
  assert.deepEqual(journeyProgress({ automation: { startedAt: start, scanned: true }, deliveries: [], queue: [] }), {
    completed: 0,
    total: null,
  });
});
test('a stale Git signal keeps the last fact and presents elapsed-time guidance', () => {
  const html = renderTask({
    id: 'test',
    action: 'heads',
    status: 'RUNNING',
    startedAt: '2000-01-01T00:00:00Z',
    steps: [
      {
        key: 'source-fetch',
        label: '下载外部对象',
        status: 'RUNNING',
        startedAt: '2000-01-01T00:00:00Z',
        progress: {
          phase: 'Receiving objects',
          percent: 47,
          completed: 47,
          total: 100,
          observedAt: '2000-01-01T00:00:01Z',
        },
      },
    ],
  });
  assert.match(html, /最近报告/);
  assert.match(html, /耗时较长/);
  assert.match(html, /47%/);
  assert.doesNotMatch(html, /自动取消|预计.*分钟/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallDuration } from '../src/call-duration.mjs';

test('call duration starts from the confirmed connection and stops when that call ends', () => {
  const node = { hidden: true, textContent: '' };
  let now = 126_000;
  let tick;
  const cleared = [];
  const duration = new CallDuration(node, {
    now: () => now,
    schedule: callback => { tick = callback; return 17; },
    cancel: handle => cleared.push(handle),
  });

  duration.set(1_000);
  assert.deepEqual(node, { hidden: false, textContent: '02:05' });
  now = 3_662_000;
  tick();
  assert.equal(node.textContent, '1:01:01');

  duration.set(null);
  assert.deepEqual(node, { hidden: true, textContent: '' });
  assert.deepEqual(cleared, [17]);
});

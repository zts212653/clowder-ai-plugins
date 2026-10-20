import assert from 'node:assert/strict';
import test from 'node:test';
import { COMPACT_BALL_SIZE, DEFAULT_BALL_SIZE, compactSizeAction } from '../src/compact-size.mjs';

test('one-click size uses the persisted Host preference and the approved compact geometry', () => {
  assert.equal(COMPACT_BALL_SIZE, 43);
  assert.equal(DEFAULT_BALL_SIZE, 72);
  assert.deepEqual(compactSizeAction(72), { label: '缩小', value: 43 });
  assert.deepEqual(compactSizeAction(120), { label: '缩小', value: 43 });
  assert.deepEqual(compactSizeAction(43), { label: '放大', value: 72 });
});

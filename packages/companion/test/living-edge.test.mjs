import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectDockedEdge } from '../src/living-edge.mjs';

test('edge observation follows the window on negative-origin and ordinary displays', () => {
  const screen = { availLeft: -1280, availWidth: 1280 };
  assert.equal(detectDockedEdge({ screen, screenX: -1250 }, { left: 8, width: 120 }), 'left');
  assert.equal(detectDockedEdge({ screen, screenX: -200 }, { left: 8, width: 120 }), null);
  assert.equal(detectDockedEdge({ screen, screenX: -160 }, { left: 32, width: 120 }), 'right');
  assert.equal(detectDockedEdge({ screen: { availLeft: 0, availWidth: 1440 }, screenX: 1250 }, { left: 32, width: 120 }), 'right');
  assert.equal(detectDockedEdge({ screen: {}, screenX: 10 }, { left: 8, width: 120 }), null);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectDockedEdge } from '../src/living-edge.mjs';

test('edge observation follows the window on negative-origin and ordinary displays', () => {
  const screen = { availLeft: -1280, availTop: 0, availWidth: 1280, availHeight: 900 };
  assert.deepEqual(detectDockedEdge({ screen, screenX: -1250, screenY: 750 }, { left: 8, top: 8, width: 120, height: 130 }), { edge: 'left', zone: 'corner' });
  assert.deepEqual(detectDockedEdge({ screen, screenX: -1250, screenY: 300 }, { left: 8, top: 8, width: 120, height: 130 }), { edge: 'left', zone: 'mid' });
  assert.equal(detectDockedEdge({ screen, screenX: -200 }, { left: 8, width: 120 }), null);
  assert.deepEqual(detectDockedEdge({ screen, screenX: -160, screenY: 200 }, { left: 32, top: 8, width: 120, height: 130 }), { edge: 'right', zone: 'mid' });
  assert.deepEqual(detectDockedEdge({ screen: { availLeft: 0, availTop: 0, availWidth: 1440, availHeight: 900 }, screenX: 1250, screenY: 750 }, { left: 32, top: 8, width: 120, height: 130 }), { edge: 'right', zone: 'corner' });
  assert.equal(detectDockedEdge({ screen: {}, screenX: 10 }, { left: 8, width: 120 }), null);
});

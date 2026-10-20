import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LIVING_GEOMETRY,
  LIVING_REFERENCE,
  LIVING_SCALE,
  livingClipFor,
  livingContentRect,
  placeLivingClip,
} from '../src/living-geometry.mjs';

const inside = (rect, label) => {
  const { surface } = LIVING_GEOMETRY;
  assert.ok(rect.left >= surface.left, `${label}: left ${rect.left} >= ${surface.left}`);
  assert.ok(rect.top >= surface.top, `${label}: top ${rect.top} >= ${surface.top}`);
  assert.ok(rect.right <= surface.right, `${label}: right ${rect.right} <= ${surface.right}`);
  assert.ok(rect.bottom <= surface.bottom, `${label}: bottom ${rect.bottom} <= ${surface.bottom}`);
};

test('decoded alpha unions for every v3 state fit one native surface contract', () => {
  inside(LIVING_GEOMETRY.sitContent, 'layered sit');
  for (const action of [
    'running-left', 'running-right', 'play', 'sleeping', 'waking', 'delivering',
    'pending_decision', 'working', 'fetching', 'studying', 'staged_thought',
  ]) {
    const selected = livingClipFor(action, 'corner');
    const placement = placeLivingClip(action, selected, 'right');
    assert.ok(Math.abs(placement.width / selected.size[0] - LIVING_SCALE) < Number.EPSILON,
      `${action}: one shared scale`);
    inside(livingContentRect(selected, placement), `${action}/start`);
    if (action === 'waking') inside(livingContentRect(selected, placement, 'end'), `${action}/end`);
  }
  for (const edge of ['left', 'right']) {
    for (const zone of ['mid', 'corner']) {
      const selected = livingClipFor('peek', zone);
      inside(livingContentRect(selected, placeLivingClip('peek', selected, edge)), `peek/${edge}/${zone}`);
    }
  }
});

test('manifest anchors use one identity centre and ground instead of action-specific correction scales', () => {
  for (const action of ['running-right', 'play', 'sleeping', 'delivering', 'pending_decision', 'working']) {
    const selected = livingClipFor(action, 'corner');
    const placement = placeLivingClip(action, selected, 'right');
    assert.ok(Math.abs(placement.left + selected.centre * LIVING_SCALE - LIVING_REFERENCE.centre) < 1e-9);
    assert.ok(Math.abs(placement.top + selected.ground * LIVING_SCALE - LIVING_REFERENCE.ground) < 1e-9);
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlaceholderScene } from '../src/living-world/placeholder-scene.mjs';
import { SCENE_FIELDS } from '../src/living-world/host-client.mjs';

test('the stand-in scene snapshots only semantic fields and restores them across a restart', () => {
  const before = createPlaceholderScene();
  before.rubHat();
  const saved = JSON.parse(JSON.stringify(before.snapshot()));
  assert.equal(saved.schemaVersion, 1);
  assert.deepEqual(Object.keys(saved).filter(key => key !== 'schemaVersion').sort(), [...SCENE_FIELDS].sort());
  assert.doesNotMatch(JSON.stringify(saved), /"\w*(?:[Tt]ime|[Cc]lock|At|[Ee]xpires)\w*":/u, 'no process clock or offline time is saved');
  const after = createPlaceholderScene();
  after.restore(saved);
  assert.deepEqual(after.snapshot(), saved);
  assert.equal(after.hat.askew, true, 'a hat knocked askew stays askew after reopening');
});

test('restore keeps defaults for anything unreadable and keeps positions on the floor', () => {
  const scene = createPlaceholderScene();
  const defaults = scene.snapshot();
  scene.restore({ schemaVersion: 2, hat: { askew: true } });
  assert.deepEqual(scene.snapshot(), defaults, 'a future schema is not half-applied');
  scene.restore({ schemaVersion: 1, pose: { name: 'FLY', facing: 'up' }, ball: { x: 7, h: -1, ceil: 'yes' },
    paper: { x: Number.NaN }, hat: { askew: 'maybe' }, activity: { kind: 'dance', frame: -3 }, lastSolo: 5 });
  assert.deepEqual(scene.snapshot(), { ...defaults, ball: { x: 1, h: 0, ceil: false } });
});

test('the cat stands on the floor of any work area and his head is the hat zone', () => {
  const scene = createPlaceholderScene();
  for (const area of [{ width: 1440, height: 875 }, { width: 1000, height: 600 }, { width: 100, height: 90 }]) {
    const rect = scene.catRect(area);
    assert.equal(rect.y + rect.height, area.height, 'feet on the bottom edge of the work area');
    assert.ok(rect.x >= 0 && rect.x + rect.width <= area.width, JSON.stringify(rect));
  }
  const area = { width: 1440, height: 875 };
  const rect = scene.catRect(area);
  assert.equal(scene.hitTest(area, { x: rect.x + rect.width / 2, y: rect.y + 5 }), 'head');
  assert.equal(scene.hitTest(area, { x: rect.x + rect.width / 2, y: rect.y + rect.height - 5 }), 'body');
  assert.equal(scene.hitTest(area, { x: 10, y: 10 }), null, 'empty desktop is not the cat');
});

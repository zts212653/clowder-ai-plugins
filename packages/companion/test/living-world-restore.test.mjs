// A saved activity behind an askew beret (PR #240 review P1-2): the beret first, then the activity from where it was
// saved, by the same RESUME_AT table as a direct restore, however long the beret takes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IN_SESSION_RESUME_MS } from '../src/living-world/brain.mjs';
import { RESUME_AT } from '../src/living-world/scene.mjs';
import { clipsOver, saved, throwBall, world } from './living-world-fixture.mjs';

const started = (clips, pattern) => clips.find(entry => pattern.test(entry.clip));
const trail = clips => clips.map(entry => `${entry.clip}[${entry.frame}]`).join(' > ');

test('askew beret + unfinished groom: he puts the beret straight, then grooms on from the saved stroke, as a direct restore would', () => {
  for (const frame of [0, 2, 5, 7, 8, 10, 11, 13, 15]) {
    const direct = world();
    direct.engine.restoreScene(saved({ pose: { hub: 'SS', facing: 'right', x: 0.4 }, activity: { kind: 'groom', frame } }));
    const w = world();
    w.engine.restoreScene(saved({ pose: { hub: 'FS', facing: 'right', x: 0.4 }, hat: { askew: true }, activity: { kind: 'groom', frame } }));
    assert.equal(w.engine.cat.clip, 'fs-hat');
    assert.deepEqual(w.engine.snapshot().activity, { kind: 'groom', frame }, 'a scene saved while the beret is askew keeps the saved frame');
    const clips = clipsOver(w, 20000);
    const groom = started(clips, /^ss-groom$/u);
    assert.ok(groom, `${frame}: ${trail(clips)}`);
    assert.equal(groom.frame, RESUME_AT.groom(frame), `${frame}: ${trail(clips)}`);
    assert.equal(groom.frame, direct.engine.cat.i, `${frame}: the same frame as without the beret`);
    assert.equal(groom.askew, false, 'the beret is straight first');
    assert.ok(clips.indexOf(groom) > clips.findIndex(entry => entry.clip === 'sit-settle'), trail(clips));
  }
});

test('askew beret + unfinished draft: he sits beside the sheet at once and studies on from the saved frame once the beret is straight', () => {
  for (const frame of [0, 3, 7, 12]) {
    const direct = world();
    direct.engine.restoreScene(saved({ pose: { hub: 'FS', facing: 'left', x: 0.8 }, paper: { x: 0.37 }, activity: { kind: 'draft', frame } }));
    const w = world();
    w.engine.restoreScene(saved({ pose: { hub: 'FS', facing: 'left', x: 0.8 }, paper: { x: 0.37 }, hat: { askew: true }, activity: { kind: 'draft', frame } }));
    assert.equal(w.engine.cat.clip, 'fs-hat');
    assert.equal(w.engine.cat.x, direct.engine.cat.x, 'where a direct restore sits him: beside the sheet, not where the pose was saved');
    assert.notEqual(w.engine.paperSide(), 0);
    assert.deepEqual(w.engine.snapshot().activity, { kind: 'draft', frame });
    const clips = clipsOver(w, 20000);
    const draft = started(clips, /^fs-draft/u);
    assert.ok(draft, `${frame}: ${trail(clips)}`);
    assert.equal(draft.frame, RESUME_AT.draft(frame), `${frame}: ${trail(clips)}`);
    assert.equal(draft.askew, false, 'the beret is straight first');
  }
});

test('the saved activity waits for the beret however long it takes: past the in-session 120 s, with a snapshot every step', () => {
  const w = world();
  w.engine.restoreScene(saved({ hat: { askew: true }, activity: { kind: 'groom', frame: 11 } }));
  const [x, y, width, height] = w.engine.catRect();
  assert.equal(w.engine.pointerDown(x + width / 2, y + height * 0.12), 'hat', 'your hand keeps rubbing the beret');
  w.run(IN_SESSION_RESUME_MS + 10000);
  assert.equal(w.engine.hatAskew(), true);
  assert.deepEqual(w.engine.snapshot().activity, { kind: 'groom', frame: 11 }, 'still saved after the in-session window');
  w.engine.pointerUp();
  const clips = clipsOver(w, 20000);
  assert.equal(started(clips, /^ss-groom$/u)?.frame, 8, trail(clips));
});

test('a ball thrown while the beret is askew goes first; the saved groom then still goes on from its stroke', () => {
  const w = world();
  w.engine.restoreScene(saved({ pose: { hub: 'FS', facing: 'right', x: 0.3 }, ball: { x: 0.8, h: 0, ceil: false },
    hat: { askew: true }, activity: { kind: 'groom', frame: 11 } }));
  w.run(500);
  throwBall(w, 500);
  const clips = clipsOver(w, 40000);
  const pounce = clips.findIndex(entry => entry.clip === 'pounce');
  const groom = started(clips, /^ss-groom$/u);
  assert.ok(pounce > 0 && groom && clips.indexOf(groom) > pounce, trail(clips));
  assert.equal(groom.frame, 8, trail(clips));
});

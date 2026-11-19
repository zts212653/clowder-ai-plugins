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

// PR #240 R2: a saved activity is put off, never finished, by being out of reach. It waits in cat.restore and the
// snapshot goes on naming it, tick by tick, until its clip is playing from the saved frame.
const CLIP_OF = { draft: /^fs-draft/u, groom: /^ss-groom$/u };
function pendingWatch(w, kind, frame) {
  const seen = { started: null, lost: null };
  const each = () => {
    const e = w.engine;
    if (!seen.started && CLIP_OF[kind].test(e.cat.clip)) seen.started = { frame: e.cat.i, askew: e.hatAskew(), at: w.now() };
    const act = e.snapshot().activity;
    if (!seen.started && !seen.lost && (act.kind !== kind || act.frame !== frame)) seen.lost = { at: w.now(), clip: e.cat.clip, act };
  };
  return { seen, each };
}
// restored with the beret askew and the sheet beside him, then a ball thrown far: he ends up far from the sheet
function farFromTheDraft(behaviorEnabled, activity = { kind: 'draft', frame: 7 }) {
  const w = world();
  w.engine.setBehaviorEnabled(behaviorEnabled);
  w.engine.restoreScene(saved({ pose: { hub: 'FS', facing: 'right', x: 0.3 }, ball: { x: 0.8, h: 0, ceil: false }, hat: { askew: true }, activity }));
  const watch = pendingWatch(w, activity.kind, activity.frame);
  w.run(500, watch.each);
  throwBall(w, 500);
  runUntil(w, () => w.engine.cat.clip === 'fs-idle' && !w.engine.ball.fresh && !w.engine.hatAskew() && w.engine.paperSide() === 0, 60000, watch.each);
  return { w, watch };
}
const runUntil = (w, done, ms, each) => { for (let t = 0; t < ms && !done(); t += 16) w.run(16, each); };
// your throw lands just past the sheet, so the chase ends with him beside it (tired by then: a nap first, then the sheet)
function throwPastTheSheet(w) {
  const e = w.engine, dir = Math.sign(e.cat.x - e.paper.x);
  Object.assign(e.ball, { x: e.paper.x - dir * 60, h: e.K.BR, vx: 0, vh: 0, fresh: true, relAt: w.now() });
}

for (const behaviorEnabled of [true, false]) {
  test(`a restored draft put off by a far chase waits, named in every snapshot, and goes on from its frame once he sits beside the sheet (autonomous ${behaviorEnabled ? 'on' : 'off'})`, () => {
    const { w, watch } = farFromTheDraft(behaviorEnabled);
    assert.ok(Math.abs(w.engine.cat.x - w.engine.paper.x) > 1000, `chased far from the sheet (${w.engine.cat.x} / ${w.engine.paper.x})`);
    w.run(20000, watch.each);   // sitting out of reach a while: still his to finish
    assert.equal(watch.seen.started, null, 'nothing resumed out of reach');
    assert.equal(watch.seen.lost, null, JSON.stringify(watch.seen.lost));
    assert.deepEqual(w.engine.cat.restore, { kind: 'draft', frame: 7 });
    runUntil(w, () => w.engine.cat.clip === 'fs-idle' && !w.engine.cat.hide, 60000, watch.each);   // out of the box, if he went in
    throwPastTheSheet(w);
    runUntil(w, () => watch.seen.started, 120000, watch.each);
    assert.equal(watch.seen.lost, null, JSON.stringify(watch.seen.lost));
    assert.ok(watch.seen.started, 'he went on with it beside the sheet');
    assert.equal(watch.seen.started.frame, RESUME_AT.draft(7));
    assert.equal(watch.seen.started.askew, false);
    assert.equal(w.engine.cat.restore, null, 'taken once it really went on');
  });

  test(`a restored groom put off by a far chase is named in every snapshot until it goes on from its stroke (autonomous ${behaviorEnabled ? 'on' : 'off'})`, () => {
    const { w, watch } = farFromTheDraft(behaviorEnabled, { kind: 'groom', frame: 11 });
    w.run(20000, watch.each);
    assert.equal(watch.seen.lost, null, JSON.stringify(watch.seen.lost));
    assert.ok(watch.seen.started, 'the groom went on');
    assert.equal(watch.seen.started.frame, RESUME_AT.groom(11));
    assert.equal(w.engine.cat.restore, null);
  });
}

test('a draft waiting out of reach is not taken by your hand, the beret, the box or a minute of his own life', () => {
  const { w, watch } = farFromTheDraft(true);
  const e = w.engine;
  const pressAt = (fy, ms) => {
    const [x, y, width, height] = e.catRect();
    const took = e.pointerDown(x + width / 2, y + height * fy);
    w.run(ms, watch.each); e.pointerUp(); w.run(4000, watch.each);
    return took;
  };
  assert.equal(pressAt(0.7, 2000), 'pet');
  assert.equal(pressAt(0.12, 1500), 'hat');
  runUntil(w, () => !e.hatAskew() && e.cat.clip === 'fs-idle', 20000, watch.each);
  e.startHide();
  let hid = false;
  runUntil(w, () => hid && !e.cat.hide, 40000, () => { watch.each(); hid = hid || !!e.cat.hide?.inBox; });
  assert.ok(hid && !e.cat.hide, 'in the box and out again');
  w.run(60000, watch.each);
  assert.equal(watch.seen.started, null, 'out of reach the whole time');
  assert.equal(watch.seen.lost, null, JSON.stringify(watch.seen.lost));
  assert.deepEqual(e.cat.restore, { kind: 'draft', frame: 7 });
});

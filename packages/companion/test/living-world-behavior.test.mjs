// The owner's 自主活动 setting on the living body (PR #240 review P1-1): body-preferences behaviorEnabled reaches the
// engine; off, he starts nothing by himself, still answers you and a thrown ball, and what is under way plays to its end.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCENE_FIELDS } from '../src/living-world/host-client.mjs';
import { clipsOver, saved, throwBall, world } from './living-world-fixture.mjs';

// what he does by himself: a draft, a groom (or turning to the side for one), the walk to the box, getting up to go
// somewhere, a daydream
const OWN = /^(?:fs-draft|ss-groom|fs-to-st|fs-to-crouch|stalk|pounce|loaf-daydream)/u;
const trail = clips => clips.map(entry => entry.clip).join(' > ');

/** Runs him and records whether he ever hid, fetched the ball himself or moved along the floor. */
function watch(w, ms) {
  const { engine } = w;
  const seen = { hide: false, fresh: false, fetched: false, x: [engine.cat.x, engine.cat.x] };
  const clips = [{ clip: engine.cat.clip }];
  w.run(ms, () => {
    if (engine.cat.hide) seen.hide = true;
    if (engine.ball.fresh) seen.fresh = true;
    if (engine.status === '他自己去找纸团玩了') seen.fetched = true;
    seen.x = [Math.min(seen.x[0], engine.cat.x), Math.max(seen.x[1], engine.cat.x)];
    if (clips.at(-1).clip !== engine.cat.clip) clips.push({ clip: engine.cat.clip });
  });
  return { ...seen, clips, moved: seen.x[1] - seen.x[0] };
}

test('on until the Host says otherwise; with nobody there for a minute he goes off by himself', () => {
  const w = world();
  assert.equal(w.engine.behaviorEnabled, true, 'a body that has not been told keeps it on');
  assert.equal(w.engine.debug().behavior, true);
  const seen = watch(w, 60000);
  assert.ok(seen.hide || seen.clips.some(entry => OWN.test(entry.clip)), `the control: he lives his own life (${trail(seen.clips)})`);
});

test('off: a minute alone and he starts nothing by himself; he sits where he is, and the setting is not saved in the scene', () => {
  const w = world();
  w.engine.setBehaviorEnabled(false);
  const seen = watch(w, 60000);
  assert.equal(seen.hide, false, 'no walk to the box');
  assert.equal(seen.fetched || seen.fresh, false, 'no fetching the ball on his own');
  assert.ok(seen.moved < 1, `no wandering (${seen.moved} px)`);
  assert.deepEqual(seen.clips.filter(entry => OWN.test(entry.clip)), [], trail(seen.clips));
  assert.deepEqual(Object.keys(w.engine.snapshot()).sort(), ['schemaVersion', ...SCENE_FIELDS].sort(), 'the preference stays the Host\'s');
});

test('off: he still answers your hand, the beret and a thrown ball', () => {
  const w = world();
  w.engine.setBehaviorEnabled(false);
  w.run(1000);
  const [x, y, width, height] = w.engine.catRect();
  assert.equal(w.engine.pointerDown(x + width / 2, y + height * 0.6), 'pet');
  w.run(600);
  assert.equal(w.engine.cat.clip, 'fs-pet', 'he leans into your hand');
  w.engine.pointerUp();
  w.run(3000);
  const [hx, hy, hw, hh] = w.engine.catRect();
  assert.equal(w.engine.pointerDown(hx + hw / 2, hy + hh * 0.12), 'hat');
  w.run(1200);
  w.engine.pointerUp();
  assert.equal(w.engine.hatAskew(), true, 'you push his beret askew');
  w.run(12000);
  assert.equal(w.engine.hatAskew(), false, 'and he puts it straight himself');
  throwBall(w, 700);
  const clips = clipsOver(w, 15000);
  assert.ok(clips.some(entry => entry.clip === 'pounce'), `he goes after the ball (${clips.map(entry => entry.clip).join(' > ')})`);
});

test('off: a groom under way and a restored one play to their end, then he stays put', () => {
  for (const turnOff of ['before the restore', 'while grooming']) {
    const w = world();
    if (turnOff === 'before the restore') w.engine.setBehaviorEnabled(false);
    w.engine.restoreScene(saved({ pose: { hub: 'SS', facing: 'right', x: 0.5 }, activity: { kind: 'groom', frame: 3 } }));
    assert.equal(w.engine.cat.clip, 'ss-groom');
    w.run(300);
    w.engine.setBehaviorEnabled(false);
    let last = w.engine.cat.i;
    for (let i = 0; i < 1000 && w.engine.cat.clip === 'ss-groom'; i++) { last = w.engine.cat.i; w.run(16); }
    assert.equal(last, w.engine.WD.clips['ss-groom'].frames.length - 1, `${turnOff}: the groom plays to its last frame, no snapping`);
    const clips = clipsOver(w, 6000);
    assert.ok(clips.some(entry => entry.clip === 'fs-idle'), `he turns back to the front (${trail(clips)})`);
    const after = watch(w, 40000);
    assert.equal(after.hide, false, turnOff);
    assert.deepEqual(after.clips.filter(entry => OWN.test(entry.clip)), [], `${turnOff}: ${trail(after.clips)}`);
  }
});

test('off: on his way to the box he still hides, comes out by himself, and then stays out', () => {
  const w = world();
  for (let i = 0; i < 2000 && !w.engine.cat.hide; i++) w.run(16);
  assert.equal(w.engine.cat.hide?.phase, 'go', 'he set off for the box with it on');
  w.engine.setBehaviorEnabled(false);
  let hid = false;
  for (let i = 0; i < 4000 && (w.engine.cat.hide || !hid); i++) { w.run(16); if (w.engine.cat.hide?.inBox) hid = true; }
  assert.equal(hid, true, 'he got in, no snapping back');
  assert.equal(w.engine.cat.hide, null, 'and came out by himself');
  const after = watch(w, 40000);
  assert.equal(after.hide, false);
  assert.deepEqual(after.clips.filter(entry => OWN.test(entry.clip) && entry.clip !== 'pounce'), [], trail(after.clips));
});

test('off: woken from a nap by himself he sits up without a daydream or a groom', () => {
  const w = world();
  w.engine.setBehaviorEnabled(false);
  w.engine.restoreScene(saved({ pose: { hub: 'NAP', facing: 'right', x: 0.5 } }));
  const clips = clipsOver(w, 40000);
  assert.ok(clips.some(entry => entry.clip === 'loaf-to-ss'), `he woke up (${trail(clips)})`);
  assert.deepEqual(clips.filter(entry => /^(?:loaf-daydream|ss-groom)$/u.test(entry.clip)), [], trail(clips));
});

test('off: a groom the ball broke off waits; turned back on, he goes back to it and his own life resumes', () => {
  const w = world();
  w.engine.setBehaviorEnabled(false);
  w.run(1000);
  w.engine.cat.resume = { kind: 'groom', i: 11, at: w.now(), facing: 1 };
  const off = clipsOver(w, 20000);
  assert.deepEqual(off.filter(entry => OWN.test(entry.clip) || entry.clip === 'fs-to-ss'), [], trail(off));
  w.engine.setBehaviorEnabled(true);
  // bored by now, he may fetch the ball first; the groom is still his to go back to within the in-session window
  const on = clipsOver(w, 60000);
  assert.ok(on.some(entry => entry.clip === 'ss-groom'), `back on: he goes back to his groom (${trail(on)})`);
});

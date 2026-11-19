import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createEngine, DEFAULT_STAND_PX } from '../src/living-world/engine.mjs';
import { createSceneWatch, GROOM_STROKES, RESUME_AT } from '../src/living-world/scene.mjs';
import { createBodyHostClient, SCENE_FIELDS } from '../src/living-world/host-client.mjs';
import { createEngineClock } from '../src/living-world/world.mjs';
import { PAPER_START, STAND_H } from '../src/living-world/constants.mjs';

const WORLD = JSON.parse(readFileSync(new URL('../assets/skins/xianxian-living-world/world.json', import.meta.url), 'utf8'));
const AREA = [1440, 860];

/** The engine on a fake clock and seeded randomness, every atlas present (nothing is drawn). */
function world({ at = 1000 } = {}) {
  let t = at;
  let seed = 11;
  const engine = createEngine({ data: WORLD, now: () => t, random: () => (seed = (seed * 16807) % 2147483647) / 2147483647 });
  engine.atlases = [true, true, true];
  engine.layout(...AREA);
  const run = (ms, each = () => {}) => { for (const end = t + ms; t < end;) { t += 16; engine.tick(t); each(); } };
  const ballAt = () => [engine.ball.x * engine.view.k, engine.view.floorY - engine.ball.h * engine.view.k];
  return { engine, run, ballAt, now: () => t, advance: ms => { t += ms; } };
}

function saved(overrides = {}) {
  return {
    schemaVersion: 1, pose: { hub: 'FS', facing: 'right', x: 0.5 }, ball: { x: 0.7, h: 0, ceil: false }, paper: { x: 0.3 },
    hat: { askew: false }, activity: { kind: null, frame: 0 }, lastSolo: null, ...overrides,
  };
}

test('a snapshot holds only the six semantic fields, as plain fractions and names, with no clock', () => {
  const { engine, run } = world();
  run(500);
  const snap = JSON.parse(JSON.stringify(engine.snapshot()));
  assert.deepEqual(Object.keys(snap).sort(), ['schemaVersion', ...SCENE_FIELDS].sort());
  assert.equal(snap.schemaVersion, 1);
  assert.deepEqual(Object.keys(snap.pose).sort(), ['facing', 'hub', 'x']);
  assert.ok(['FS', 'SS', 'LOAF', 'NAP'].includes(snap.pose.hub));
  assert.ok(['left', 'right'].includes(snap.pose.facing));
  assert.deepEqual(Object.keys(snap.ball).sort(), ['ceil', 'h', 'x']);
  assert.deepEqual(Object.keys(snap.paper), ['x']);
  assert.deepEqual(snap.hat, { askew: false });
  assert.deepEqual(snap.activity, { kind: null, frame: 0 });
  assert.equal(snap.lastSolo, null);
  for (const value of [snap.pose.x, snap.ball.x, snap.ball.h, snap.paper.x]) assert.ok(value >= 0 && value <= 1, String(value));
  assert.doesNotMatch(JSON.stringify(snap), /"\w*(?:[Tt]ime|[Cc]lock|At|[Uu]ntil|[Ee]xpires|since)\w*":/u, 'no process clock or offline time is saved');
  assert.deepEqual(engine.snapshot(), engine.snapshot(), 'reading a snapshot changes nothing');
});

test('restore: a draft at frame N goes on at N, beside the paper where it lay', () => {
  for (const frame of [0, 7, 12]) {
    const { engine } = world();
    assert.equal(engine.restoreScene(saved({ pose: { hub: 'FS', facing: 'left', x: 0.4 }, paper: { x: 0.37 }, activity: { kind: 'draft', frame } })), true);
    assert.match(engine.cat.clip, /^fs-draft/u);
    assert.equal(engine.cat.i, frame, `draft frame ${frame}`);
    assert.deepEqual(engine.snapshot().activity, { kind: 'draft', frame });
    assert.ok(engine.paperSide() !== 0, 'he sits where his paw reaches the sheet');
  }
});

test('restore: a groom goes on from the start of the stroke the saved frame is in, never from an exit frame', () => {
  const exits = WORLD.clips['ss-groom'].exits;
  for (const start of new Set(GROOM_STROKES.map(([from]) => from))) assert.ok(!exits.includes(start), `stroke start ${start} is not an exit frame`);
  const expected = { 0: 3, 2: 3, 5: 3, 7: 3, 8: 8, 9: 8, 10: 8, 11: 8, 13: 8, 15: 8 };
  for (const [frame, at] of Object.entries(expected)) {
    assert.equal(RESUME_AT.groom(Number(frame)), at, `groom frame ${frame}`);
    const { engine } = world();
    engine.restoreScene(saved({ pose: { hub: 'SS', facing: 'right', x: 0.5 }, activity: { kind: 'groom', frame: Number(frame) } }));
    assert.equal(engine.cat.clip, 'ss-groom');
    assert.equal(engine.cat.i, at);
  }
  assert.equal(RESUME_AT.draft(9), 9);
});

test('restore: an askew beret stays askew until he puts it straight himself, however long he was away', () => {
  const { engine, run, advance } = world();
  advance(10 * 24 * 3600 * 1000);   // ten days away count for nothing
  engine.restoreScene(saved({ hat: { askew: true } }));
  assert.equal(engine.cat.clip, 'fs-hat');
  assert.equal(engine.cat.i, WORLD.clips['fs-hat'].tiltHold[0]);
  assert.equal(engine.snapshot().hat.askew, true);
  run(2000);
  assert.equal(engine.snapshot().hat.askew, true, 'still askew: the hold is at least 2.5 s');
  run(9000);
  assert.equal(engine.snapshot().hat.askew, false, 'then he fixes it with his own paw');
  assert.notEqual(engine.cat.clip, 'fs-hat');
});

test('restore: ball, paper and pose come back where they were; a foreign snapshot changes nothing', () => {
  const { engine, run } = world();
  engine.restoreScene(saved({ pose: { hub: 'NAP', facing: 'left', x: 0.25 }, ball: { x: 0.9, h: 0.0212, ceil: false }, paper: { x: 0.6 } }));
  assert.equal(engine.cat.clip, 'nap');
  assert.equal(engine.cat.facing, -1);
  run(100);
  const snap = engine.snapshot();
  assert.deepEqual({ pose: snap.pose, ball: snap.ball, paper: snap.paper },
    { pose: { hub: 'NAP', facing: 'left', x: 0.25 }, ball: { x: 0.9, h: 0.0212, ceil: false }, paper: { x: 0.6 } });
  engine.restoreScene(saved({ pose: { hub: 'LOAF', facing: 'right', x: 0.5 } }));
  assert.equal(engine.cat.clip, 'loaf-daydream');
  engine.restoreScene(saved({ pose: { hub: 'SS', facing: 'right', x: 0.5 }, ball: { x: 0.5, h: 1, ceil: true } }));
  assert.equal(engine.cat.clip, 'ss-idle');
  assert.equal(engine.snapshot().ball.ceil, true);
  assert.equal(engine.ball.fresh, false, 'a restored ball is not thrown again: nothing from the time away is replayed');
  const before = JSON.stringify(engine.snapshot());
  assert.equal(engine.restoreScene({ schemaVersion: 2, pose: { hub: 'NAP' } }), false);
  assert.equal(JSON.stringify(engine.snapshot()), before);
});

/** Engine + scene watch + the real host client on a recording bridge; publishes like world.mjs. */
function hosted() {
  const w = world();
  const sent = [];
  const bridge = {
    async request(command) {
      sent.push(structuredClone(command));
      return command.kind === 'scene.get' ? { kind: 'scene', status: 'not_found' } : { kind: 'ok' };
    },
    subscribe: () => () => {},
  };
  const timers = { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} };
  const client = createBodyHostClient({ bridge, timers, visibility: { hidden: () => false, subscribe: () => () => {} } });
  const watch = createSceneWatch(w.engine, () => { void client.sceneChanged(); });
  const step = () => {
    watch.check();
    client.setHitRects(w.engine.hitRects());
    client.setAnchor(w.engine.anchorRect());
  };
  const of = kind => sent.filter(command => command.kind === kind);
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { ...w, client, watch, step, of, flush, sent, run: ms => w.run(ms, step) };
}

test('each semantic moment reports the scene with the fields that moved', async () => {
  const h = hosted();
  const { engine } = h;
  await h.client.start({ snapshot: () => engine.snapshot(), onScene: () => h.watch.reset(), onArea() {} });
  await h.flush();
  assert.deepEqual(h.of('scene.report').map(report => report.dirty), [[...SCENE_FIELDS]], 'not_found starts and saves a new scene');
  engine.cat.pauseUntil = Infinity;   // sitting still, not looking anywhere
  h.run(300); await h.flush();
  assert.equal(h.of('scene.report').length, 1, 'nothing semantic happened');

  // the beret: askew, then straight again
  const [x, y, width, height] = engine.catRect();
  engine.pointerDown(x + width / 2, y + height * 0.12);
  h.run(1600); engine.pointerUp(); h.run(100); await h.flush();
  const askew = h.of('scene.report').at(-1);
  assert.deepEqual(askew.dirty, ['hat']);
  assert.equal(askew.snapshot.hat.askew, true);
  h.run(12000); await h.flush();
  const fixed = h.of('scene.report').slice(h.of('scene.report').indexOf(askew) + 1).find(report => report.snapshot.hat.askew === false);
  assert.deepEqual(fixed?.dirty, ['hat'], 'he puts it straight: one more report');

  // the ball: picked up, then thrown; it settles somewhere else
  const reports = h.of('scene.report').length;
  engine.cat.pauseUntil = Infinity;
  const [bx, by] = h.ballAt();
  assert.equal(engine.pointerDown(bx, by), 'ball');
  h.step(); await h.flush();
  assert.equal(h.of('scene.report').length, reports + 1, 'picked up');
  for (let i = 1; i <= 5; i++) { h.advance(16); engine.pointerMove(bx - i * 30, by - i * 10); engine.tick(h.now()); }
  engine.pointerUp();
  let settled;
  for (let i = 0; i < 400 && !settled; i++) {
    h.run(16); await h.flush();
    settled = h.of('scene.report').slice(reports + 1).find(report => report.dirty.includes('ball'));
  }
  assert.ok(settled, 'it settled and the new place was reported');
  assert.equal(engine.ballMoment(), 'rest');

  // an activity starts (pose and paper held still around it)
  const fresh = hosted();
  await fresh.client.start({ snapshot: () => fresh.engine.snapshot(), onScene: () => fresh.watch.reset(), onArea() {} });
  await fresh.flush();
  fresh.engine.cat.facing = 1;
  assert.equal(fresh.engine.paper.x, fresh.engine.cat.x + PAPER_START, 'his draft lies under his paw');
  fresh.engine.play('fs-draft');
  fresh.step(); await fresh.flush();
  assert.deepEqual(fresh.of('scene.report').at(-1).dirty, ['activity']);
  // and the pose changes: he turns to the side
  fresh.engine.play('fs-to-ss');
  fresh.run(4000); await fresh.flush();
  assert.ok(fresh.of('scene.report').some(report => report.dirty.includes('pose') && report.snapshot.pose.hub === 'SS'));
});

test('the click region and the anchor are sent only when they change', async () => {
  const h = hosted();
  const { engine } = h;
  await h.client.start({ snapshot: () => engine.snapshot(), onScene: () => h.watch.reset(), onArea() {} });
  engine.cat.pauseUntil = Infinity;
  h.run(400); await h.flush();
  const hits = h.of('body.hit').length, anchors = h.of('body.anchor').length;
  assert.equal(h.of('body.hit').at(-1).rects.length, 2, 'the cat and the paper ball');
  h.run(2000); await h.flush();
  assert.equal(h.of('body.hit').length, hits, 'a still cat and a still ball: no new region');
  assert.equal(h.of('body.anchor').length, anchors, 'and no new anchor');
  const keys = new Set();
  for (let i = 0; i < 30; i++) { h.run(16); keys.add(engine.renderKey(h.now())); }
  assert.equal(keys.size, 1, 'and nothing to repaint');
  const [bx, by] = h.ballAt();
  engine.pointerDown(bx, by);
  engine.pointerMove(bx - 200, by - 120);
  h.run(32); await h.flush();
  assert.ok(h.of('body.hit').length > hits, 'the ball moved: the region follows it');
  for (const { rects } of h.of('body.hit')) {
    assert.ok(rects.length <= 8);
    for (const rect of rects) assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= AREA[0] && rect.y + rect.height <= AREA[1], JSON.stringify(rect));
  }
});

test('a press on empty space is the desktop\'s click: it never picks up the ball', () => {
  const { engine, ballAt } = world();
  const [bx, by] = ballAt();
  assert.equal(engine.pointerDown(bx - 200, by - 300), null);
  engine.pointerMove(bx - 400, by - 400);
  engine.pointerUp();
  assert.equal(engine.ball.held, false);
  assert.equal(engine.ball.fresh, false);
  assert.equal(engine.ptr.down, false, 'and the hand is free again: he may sniff it');
});

test('a new work area keeps him, the ball and the paper on screen', () => {
  const { engine } = world();
  engine.cat.x = engine.view.worldW - 50;
  engine.ball.x = engine.view.worldW - 10;
  engine.layout(800, 600);
  const snap = engine.snapshot();
  const [x, y, width, height] = engine.catRect();
  assert.ok(x >= 0 && x + width <= 800 && y + height <= 600, JSON.stringify([x, y, width, height]));
  for (const value of [snap.pose.x, snap.ball.x, snap.paper.x]) assert.ok(value > 0 && value < 1);
});

test('his standing height follows layout: the default until named, kept when not named again, capped to stay clickable', () => {
  const { engine } = world();
  const standing = () => engine.catRect()[3] / (engine.WD.frames[engine.curFrame()][3] / engine.WD.scale) * STAND_H;
  assert.equal(engine.view.k, DEFAULT_STAND_PX / STAND_H, 'before the Host names a height he stands at the default');
  assert.equal(Math.round(standing()), DEFAULT_STAND_PX);
  const before = { cat: engine.cat.x, ball: engine.ball.x, paper: engine.paper.x };
  engine.layout(...AREA, 200);
  assert.equal(engine.view.k, 200 / STAND_H);
  assert.equal(Math.round(standing()), 200, 'his drawn sprite scales with the named height');
  assert.deepEqual({ cat: engine.cat.x, paper: engine.paper.x }, { cat: before.cat, paper: before.paper },
    'canon positions stay, so the box and his paper keep their places around him');
  assert.ok(engine.ball.x <= before.ball && (engine.ball.x + engine.K.BR) * engine.view.k <= AREA[0] + 1e-6,
    'a ball the bigger cat\'s shorter floor no longer holds is put back on it');
  engine.layout(1280, 700);
  assert.equal(engine.view.k, 200 / STAND_H, 'a new work area without a height keeps the one he has');
  const [x, y, width, height] = engine.catRect();
  assert.ok(x >= 0 && x + width <= 1280 && y + height <= 700, JSON.stringify([x, y, width, height]));
  engine.layout(1280, 720, 480);
  const largest = Math.max(...WORLD.frames.map(([, , w, h]) => (w / WORLD.scale) * (h / WORLD.scale))) + WORLD.ballD ** 2;
  assert.ok(STAND_H * engine.view.k < 480, `on a small screen the biggest setting is capped (${Math.round(STAND_H * engine.view.k)} px)`);
  assert.ok(largest * engine.view.k ** 2 <= 0.15 * 1280 * 720, 'his largest frame and the ball stay inside the Host\'s 15% click budget');
  engine.layout(3008, 1660, 480);
  assert.equal(engine.view.k, 480 / STAND_H, 'a screen big enough holds him at the named height');
});

test('the engine clock does not count the time the window was hidden', () => {
  let page = 5000;
  const clock = createEngineClock({ now: () => page });
  assert.equal(clock.now(), 5000);
  page += 100;
  clock.pause();
  page += 60000;
  assert.equal(clock.now(), 5100, 'stopped while hidden');
  clock.pause();
  clock.resume();
  page += 40;
  assert.equal(clock.now(), 5140, 'the minute away is taken out');
  clock.resume();
  assert.equal(clock.now(), 5140);
});

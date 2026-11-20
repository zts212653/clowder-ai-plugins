// F336 Phase C: the card's sprite engine ("宪宪和纸团" v30) as a desktop body. One engine object carries the state every
// part reads (cat, ball, hand, paper, hearts, the view); the parts install their functions onto it.
// Desktop mapping (plan C): the canvas is the transparent body window over the primary work area. The floor is the
// bottom of the work area, the walls its left and right edges, the ceiling its top. There is no room: only the cat, his
// paper ball, his draft and the cardboard box on the floor by the left wall.
// Time is the caller's clock (world.mjs stops it while the window is hidden), so nothing he does counts time he was away.
import { HANG_PAW, PAPER_START, PW, STAND_H, deriveConstants } from './constants.mjs';
import { installSenses } from './senses.mjs';
import { installMotion } from './motion.mjs';
import { installBrain } from './brain.mjs';
import { installStep } from './step.mjs';
import { installHide } from './hide.mjs';
import { installInput } from './input.mjs';
import { installDraw } from './draw.mjs';
import { installScene } from './scene.mjs';

/** His standing height on the desktop, in CSS px (the card used 31.5% of its room's height), until the Host's body-area
 * names one (standHeight, derived from the ballSize setting). */
export const DEFAULT_STAND_PX = 150;
// The Host refuses, whole, a click region over 15% of the work area: his largest frame plus the ball stay within 14% of
// it, so the biggest size setting on a small screen makes him as big as the screen allows, never unclickable.
export const HIT_SHARE_BUDGET = 0.14;
// the floor line sits this many canon px above the work area's bottom edge, so the shadows, the near edge of his draft
// and the foot of the box (all drawn a little in front of the line) are not cut off by the edge
export const FLOOR_PAD = 16;

const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high));

export function createEngine({ data, now = () => performance.now(), random = Math.random, standPx = DEFAULT_STAND_PX }) {
  const WD = data;
  const K = deriveConstants(WD);
  const view = { W: 0, H: 0, dpr: 1, k: standPx / STAND_H, floorY: 0, worldW: 1600, CEIL: 900, HANGY: 300 };
  // canon px² of his largest frame and of the ball's box: what the click region can cover at most
  const largestHit = Math.max(...WD.frames.map(([, , w, h]) => (w / WD.scale) * (h / WD.scale))) + (2 * K.BR) ** 2;
  const cat = { x: NaN, y: 0, facing: 1, clip: 'fs-idle', i: 0, acc: 0, energy: 1, loops: 0, pauseUntil: 0, leap: 0, lookI: 0, since: 0, last: '', wall: null, mir: 1, spread: null, fix: null, climbExtra: 0, climbLeft: 0, miss: false, playedAt: -1e9 };
  const ball = { x: NaN, h: K.BR, vx: 0, vh: 0, held: false, fresh: false, spin: 0, relAt: -1e9, pin: false, pinOff: 0, sq: 0, sqv: 0, sqTo: 0, ceil: false };
  const ptr = { x: 0, y: 0, at: -1e9, down: false, hist: [] };
  const paper = { x: NaN, grab: null, tilt: -0.035 };
  const hearts = [];
  // atlases: [0] front sit (small, he appears at once), [1] every other floor move, [2] the wall and ceiling chain
  // behaviorEnabled: the owner's 自主活动 setting, which the Host sends as body-preferences; on until it says otherwise
  const e = { WD, K, view, cat, ball, ptr, paper, hearts, atlases: [null, null, null], status: '', now, random, behaviorEnabled: true };
  installSenses(e); installMotion(e); installBrain(e); installStep(e); installHide(e); installInput(e); installDraw(e); installScene(e);

  // The work area or his size can change under him (Dock, display, the size setting): he is put back on the new floor,
  // never off screen. On the wall or the ceiling he lets go and sits on the floor where he was, since that wall or ceiling
  // has moved. Positions stay in canon px, so the box, the paper and the ball keep their places around him.
  function layout(width, height, nextStandPx = standPx) {
    if (!(width >= 20 && height >= 20)) return false;
    if (Number.isFinite(nextStandPx) && nextStandPx > 0) standPx = nextStandPx;
    const k = Math.min(standPx, STAND_H * Math.sqrt(HIT_SHARE_BUDGET * width * height / largestHit)) / STAND_H;
    const moved = view.W > 0;
    view.W = width; view.H = height; view.k = k;
    view.floorY = height - FLOOR_PAD * view.k; view.worldW = width / view.k; view.CEIL = view.floorY / view.k; view.HANGY = view.CEIL - HANG_PAW;
    if (moved && cat.wall && e.clip().wall) {
      Object.assign(cat, { wall: null, y: 0, fix: null, spread: null, climbLeft: 0, facing: cat.x < view.worldW / 2 ? 1 : -1 });
      e.play('fs-idle'); cat.pauseUntil = now() + 800;
    }
    if (cat.wall && (cat.clip === 'climb' || cat.clip === 'wall-up')) cat.x = e.wallAnchor();
    if (!Number.isFinite(cat.x)) cat.x = view.worldW * 0.42;
    if (!Number.isFinite(ball.x) || !Number.isFinite(ball.h)) { ball.x = view.worldW * 0.78; ball.h = K.BR; ball.vx = 0; ball.vh = 0; }
    if (!cat.hide) cat.x = clamp(cat.x, 170, view.worldW - 170);
    ball.x = clamp(ball.x, K.BR, view.worldW - K.BR);
    ball.h = ball.ceil ? view.CEIL - K.BR : Math.min(ball.h, view.CEIL - K.BR);
    if (!Number.isFinite(paper.x)) paper.x = cat.x + PAPER_START;
    paper.x = clamp(paper.x, PW / 2, view.worldW - PW / 2);
    return true;
  }

  /** Off: he starts nothing by himself (brain.mjs); what is under way plays out, and he still answers you and the ball. */
  function setBehaviorEnabled(enabled) { e.behaviorEnabled = enabled; }

  let prev = 0;
  let acc = 0;
  // a frame waits for its atlas: a cat restored into a pose of the second atlas holds still until it is there
  const frameReady = () => !!e.atlases[0] && !!e.atlases[WD.frames[e.drawnFrame()][6] || 0];
  /** One animation tick at engine time ts (ms). */
  function tick(ts) {
    if (!view.W) return;
    if (!Number.isFinite(cat.x) || !Number.isFinite(ball.x)) layout(view.W, view.H);   // a position stopped being a number: put him back
    if (!prev) prev = ts;
    const dt = Math.min(0.05, Math.max(0, (ts - prev) / 1000)); prev = ts;
    e.stepBall(dt);
    if (cat.clip !== 'stalk' && cat.clip !== 'pounce' && cat.clip !== 'nap' && cat.clip !== 'ssd-play') cat.energy = Math.min(1, cat.energy + dt * 0.003);
    if (frameReady()) {
      acc += dt * 1000; let guard = 0;
      while (acc >= e.frameMs() && guard++ < 8) {
        acc -= e.frameMs(); const was = cat.clip; e.stepCat(ts);
        if (cat.clip !== was) acc = Math.min(acc, 0);   // a new clip starts on its own clock (碳碳 11-18: time saved up on a slow idle frame ran a 40 ms clip several frames at once)
      }
    }
    if (cat.hide && cat.hide.tw) e.stepTween(now());   // the head goes up/down smoothly between frame steps
  }
  /** The card's window.__xxCat: what he is doing, for tests and for people watching. */
  function debug() {
    const r = Math.round, act = e.activityNow();
    return {
      hide: cat.hide ? cat.hide.phase + (cat.hide.p ? ':' + cat.hide.p : '') : null, inBox: !!(cat.hide && cat.hide.inBox), sink: r(cat.sink || 0),
      peekAt: cat.hide && cat.hide.phase === 'peek' ? e.catRect().map(r) : null, rimY: r(e.rimY()), room: [r(view.W), r(view.H)],
      clip: cat.clip, i: cat.i, x: r(cat.x), facing: cat.facing, energy: +cat.energy.toFixed(2),
      ready: !!e.atlases[0], full: !!e.atlases[1], climb: !!e.atlases[2], y: r(cat.y), wall: cat.wall,
      ball: { ceil: ball.ceil, x: r(ball.x), h: r(ball.h), vx: r(ball.vx), held: ball.held, fresh: ball.fresh, pin: ball.pin, sq: +ball.sq.toFixed(2) },
      status: e.status, worldW: r(view.worldW), paper: r(paper.x), pet: !!cat.pet, hearts: hearts.length, rub: !!cat.rub,
      resume: cat.resume ? cat.resume.kind : null, pose: e.poseHub(), askew: e.hatAskew(), activity: act ? `${act.kind}:${act.frame}` : null,
      stand: r(STAND_H * view.k), behavior: e.behaviorEnabled,
    };
  }

  Object.assign(e, { layout, setBehaviorEnabled, tick, debug });
  return e;
}

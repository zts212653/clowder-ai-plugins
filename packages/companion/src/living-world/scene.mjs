// F336 Phase C: the scene as the Host saves it, and where the cat can be clicked.
// - snapshot() holds semantic state only: no process clock, nothing discounted by offline time, nothing that expires.
//   Positions are fractions of the floor width (the ball's height a fraction of floor-to-ceiling), so a new
//   resolution keeps him on screen. The in-session cat.resume (120 s, engine clock) stays for in-session interruptions.
// - restoreScene() puts him straight into the saved pose: no walking there, nothing replayed from the time he was away.
//   A saved activity goes on where RESUME_AT says, at once or, behind an askew beret, once he has put it straight
//   (cat.restore: the saved frame, no clock; never the in-session cat.resume).
// - createSceneWatch() names the semantic moments the Host must hear about at once: the ball settles or is picked up,
//   the beret goes askew or straight, an activity starts, is interrupted or ends, the pose changes.
import { IN_SESSION_RESUME_MS } from './brain.mjs';
import { PAPER_START } from './constants.mjs';

export const SCHEMA_VERSION = 1;
const RESTORABLE = new Set(['FS', 'SS', 'LOAF', 'NAP']);
// the pose a reopened cat sits in for each hub of the motion graph: the chase and the wall are not resumed
export const POSE_OF_HUB = Object.freeze({
  FS: 'FS', SS: 'SS', LOAF: 'LOAF', NAP: 'NAP', SSD: 'SS', STALK: 'FS', CROUCH: 'FS', CLIMB: 'FS', HANG: 'FS', DROP: 'FS',
});
const FACING = Object.freeze({ left: -1, right: 1 });
const SOLOS = new Set(['draft', 'groom', 'hide']);
// ss-groom (solo-groom-03, 16 frames): 0-2 he settles, 3-7 he licks the raised paw, 8-10 he washes his face with it,
// 11-15 the paw comes down (exits 0, 1, 11, 12, 13, 15 are those near the side sit).
export const GROOM_STROKES = Object.freeze([[3, 7], [8, 10]]);
// Where a saved activity picks up again. The study goes on from the frame he was looking at. A groom starts again at the
// start of the stroke the saved frame is in, never from an exit frame: v21 resumed from the frame he broke off at, and
// he sat back up without a single lick. Before the first stroke: the first; after the last: the last.
export const RESUME_AT = Object.freeze({
  draft: frame => frame,
  groom: frame => (GROOM_STROKES.find(([, end]) => frame <= end) ?? GROOM_STROKES.at(-1))[0],
});

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFraction = value => Number.isFinite(value) && value >= 0 && value <= 1;
const fraction = value => (Number.isFinite(value) ? Math.round(Math.min(1, Math.max(0, value)) * 1e4) / 1e4 : 0.5);

export function installScene(e) {
  const { WD, K, cat, ball, paper, hearts, view: v } = e;
  const { BR, HAT } = K;
  const play = (name, at) => e.play(name, at);

  function poseHub() { return POSE_OF_HUB[e.clip().frm] || 'FS'; }
  // askew from the first rubbing frame until the fix has played out (a reopened cat whose fix was cut short fixes it again)
  function hatAskew() { return cat.clip === 'fs-hat' && cat.i >= HAT.rubLoop[0]; }
  function activityNow() {
    if (/^fs-draft/.test(cat.clip)) return { kind: 'draft', frame: Math.max(0, cat.i), active: true };
    if (cat.clip === 'ss-groom') return { kind: 'groom', frame: Math.max(0, cat.i), active: true };
    if (cat.restore) return { kind: cat.restore.kind, frame: cat.restore.frame, active: false };   // saved, waiting for the beret
    const rs = cat.resume;
    if (rs && (rs.kind === 'draft' || rs.kind === 'groom') && e.now() - rs.at < IN_SESSION_RESUME_MS) return { kind: rs.kind, frame: rs.i, active: false };
    return null;
  }
  function ballMoment() {
    if (ball.held) return 'held';
    if (ball.ceil) return 'ceil';
    return !ball.pin && ball.h <= BR && ball.vx === 0 && ball.vh === 0 ? 'rest' : 'moving';
  }
  function snapshot() {
    const width = v.worldW > 0 ? v.worldW : 1, height = v.CEIL > 0 ? v.CEIL : 1, act = activityNow();
    return {
      schemaVersion: SCHEMA_VERSION,
      pose: { hub: poseHub(), facing: cat.facing < 0 ? 'left' : 'right', x: fraction(cat.x / width) },
      ball: { x: fraction(ball.x / width), h: fraction(ball.h / height), ceil: ball.ceil === true },
      paper: { x: fraction(paper.x / width) },
      hat: { askew: hatAskew() },
      activity: act ? { kind: act.kind, frame: act.frame } : { kind: null, frame: 0 },
      lastSolo: SOLOS.has(cat.lastSolo) ? cat.lastSolo : null,
    };
  }
  function sitIn(hub) {
    if (hub === 'SS') return play('ss-idle');
    if (hub === 'NAP') return play('nap');
    if (hub === 'LOAF') { cat.dayN = 2; return play('loaf-daydream'); }   // a short daydream, then he sits up as he would
    play('fs-idle'); cat.pauseUntil = e.now() + 800;
  }
  // the draft lies where it was; he sits beside it, on the side his saved facing says, or the other if a wall is there
  function sitByPaper(facing) {
    for (const dir of [facing, -facing]) {
      cat.facing = dir; cat.x = Math.min(Math.max(paper.x - dir * PAPER_START, 170), v.worldW - 170);
      if (e.paperSide() === dir) return true;
    }
    return false;
  }
  // the activity an askew beret put off (cat.restore), once it is straight: from where it was saved, by the same table as
  // a direct restore. A groom: he turns to the side and starts the saved stroke (brain.mjs SS clears cat.restore as it
  // starts, so a ball meanwhile leaves it waiting). A draft: he was put beside the sheet on restore; out of his reach now
  // (a new work area moved it), he leaves it.
  function resumeRestored() {
    const { kind, frame } = cat.restore;
    if (kind === 'groom') { cat.want = 'groom'; cat.groomAt = RESUME_AT.groom(frame); play('fs-to-ss'); e.say('他接着把毛理完'); return true; }
    cat.restore = null;
    const side = e.paperSide();
    if (!side) return false;
    cat.facing = side; play('fs-draft', RESUME_AT.draft(frame)); e.say('他接着研究刚才的草稿'); return true;
  }
  /** Puts him straight into the saved scene. Anything unreadable keeps what he has; returns false for a foreign snapshot. */
  function restoreScene(snap) {
    if (!plain(snap) || snap.schemaVersion !== SCHEMA_VERSION) return false;
    const field = name => (plain(snap[name]) ? snap[name] : {});
    const pose = field('pose'), activity = field('activity');
    // what this run had going is let go: no hiding, no hand, no lure, no wall, no leftover hearts
    Object.assign(cat, {
      hide: null, sink: 0, wall: null, y: 0, fix: null, spread: null, lure: null, pet: false, rub: false, rubAfterSniff: false,
      resume: null, restore: null, want: null, tiltUntil: 0, miss: false, climbLeft: 0, leap: 0, groomAt: 0, nearSince: 0, leftAt: 0, hurry: false,
    });
    hearts.length = 0; paper.grab = null;
    Object.assign(ball, { held: false, pin: false, fresh: false, vx: 0, vh: 0, sq: 0, sqv: 0, sqTo: 0 });
    const saved = { ball: field('ball'), paper: field('paper') };
    if (isFraction(saved.ball.x)) ball.x = saved.ball.x * v.worldW;
    ball.ceil = saved.ball.ceil === true;
    ball.h = ball.ceil ? v.CEIL - BR : Math.max(BR, isFraction(saved.ball.h) ? saved.ball.h * v.CEIL : BR);   // a ball saved in the hand falls
    if (isFraction(saved.paper.x)) paper.x = saved.paper.x * v.worldW;
    if (FACING[pose.facing]) cat.facing = FACING[pose.facing];
    if (isFraction(pose.x)) cat.x = pose.x * v.worldW;
    if (snap.lastSolo === null || SOLOS.has(snap.lastSolo)) cat.lastSolo = snap.lastSolo ?? undefined;
    if (cat.lastSolo === 'hide') cat.lastHide = 1;
    e.layout(v.W, v.H);   // clamp everything onto this floor
    const kind = activity.kind === 'draft' || activity.kind === 'groom' ? activity.kind : null;
    const clipOf = { draft: 'fs-draft', groom: 'ss-groom' }[kind];
    const frame = kind ? Math.min(WD.clips[clipOf].frames.length - 1, Number.isInteger(activity.frame) && activity.frame >= 0 ? activity.frame : 0) : 0;
    if (field('hat').askew === true && HAT) {
      // the beret stays askew until he puts it straight himself; an unfinished activity waits for him, with its saved
      // frame (a draft: he sits beside the sheet now, as below, so his paw reaches it once the beret is straight)
      if (kind === 'groom' || (kind === 'draft' && sitByPaper(cat.facing))) cat.restore = { kind, frame };
      play('fs-hat', HAT.tiltHold[0]);
    } else if (kind === 'draft' && sitByPaper(cat.facing)) {
      play('fs-draft', RESUME_AT.draft(frame));
    } else if (kind === 'groom') {
      play('ss-groom', RESUME_AT.groom(frame));
    } else {
      sitIn(RESTORABLE.has(pose.hub) ? pose.hub : 'FS');
    }
    return true;
  }

  // ---- where he can be clicked, in body-window CSS px; the box itself never takes a click
  function visibleCatRect() {
    const r = e.catRect();
    if (cat.hide && cat.hide.inBox) {   // in the box only the part over the rim shows
      const ry = e.rimY();
      if (r[1] >= ry) return null;
      r[3] = Math.min(r[3], ry - r[1]);
    }
    return r;
  }
  function windowRect([x, y, width, height]) {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(v.W, Math.ceil(x + width)), y1 = Math.min(v.H, Math.ceil(y + height));
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
  }
  const drawn = frame => !!e.atlases[0] && !!e.atlases[WD.frames[frame][6] || 0];
  /** The cat as drawn (his head while he peeks over the rim) and the paper ball: at most two rects. */
  function hitRects() {
    const rects = [];
    const body = drawn(e.drawnFrame()) ? visibleCatRect() : null;
    if (body) rects.push(windowRect(body));
    if (drawn(WD.ball)) {
      const r = e.ballRadius();
      rects.push(windowRect([ball.x * v.k - r, v.floorY - ball.h * v.k - r, r * 2, r * 2]));
    }
    return rects.filter(Boolean);
  }
  /** His visible body; while none of him shows, the box he is in. */
  function anchorRect() { return windowRect(visibleCatRect() || e.boxRect()); }
  function menuHit(x, y) {
    const r = drawn(e.drawnFrame()) ? visibleCatRect() : null;
    return !!r && x >= r[0] && x <= r[0] + r[2] && y >= r[1] && y <= r[1] + r[3];
  }

  Object.assign(e, { poseHub, hatAskew, activityNow, ballMoment, snapshot, restoreScene, resumeRestored, hitRects, anchorRect, menuHit });
}

/** Calls onMoment once per semantic moment; reset() takes the current scene as seen (after a restore). */
export function createSceneWatch(engine, onMoment) {
  let seen;
  let ballAt = 'rest';
  function read() {
    const moment = engine.ballMoment();
    if (moment !== 'moving') ballAt = moment;   // in flight, under his paws: the moment is when it settles
    const act = engine.activityNow();
    return JSON.stringify([engine.poseHub(), engine.hatAskew(), act ? `${act.active ? 'doing' : 'left'}:${act.kind}` : null, ballAt, engine.cat.lastSolo ?? null]);
  }
  return {
    reset() { seen = read(); },
    check() {
      const now = read();
      const changed = seen !== undefined && now !== seen;
      seen = now;
      if (changed) onMoment();
      return changed;
    },
  };
}

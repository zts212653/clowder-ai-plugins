// F336 Phase C: your pointer is the hand (ported from the card engine). On the desktop a press on empty space is you
// clicking your own desktop, so only a press on the paper ball picks it up (the card picked it up from anywhere);
// petting, the beret, sniffing, the fast hand and finding him in the box stay as in the card.
import { MAXLEAP, PETBACK } from './constants.mjs';

export function installInput(e) {
  const { WD, K, cat, ball, ptr, view: v } = e;
  const { BR, HAT, REACH } = K;

  function pointerMove(x, y) {
    ptr.x = x; ptr.y = y; ptr.at = e.now(); ptr.hist.push([x, y, ptr.at]); if (ptr.hist.length > 8) ptr.hist.shift();
    if (cat.lure && (/^fs-to-crouch/.test(cat.clip) || cat.clip === 'crouch-wait') && e.fastSweep()) {
      const lw = e.worldPtr();
      if (lw && lw[1] < 260) {
        if ((lw[0] - cat.x) * cat.facing > 0 && Math.abs(lw[0] - cat.x) < REACH + MAXLEAP + 60) cat.lure.next = { x: lw[0], at: ptr.at };
        else cat.lure.at = ptr.at;
      }
    }
  }
  /** The ball under a window point: the drawn ball, a little generous so a small target is easy to take. */
  function ballHit(x, y) {
    if (!e.atlases[WD.frames[WD.ball][6] || 0]) return false;
    return Math.hypot(x - ball.x * v.k, y - (v.floorY - ball.h * v.k)) <= ballRadius();
  }
  function ballRadius() { return Math.max(BR * v.k * 1.25, 10); }
  function pickUp() { ball.held = true; ball.pin = false; ball.ceil = false; ball.sqTo = 0; ball.fresh = false; return 'ball'; }
  /** A primary press. Returns what it took ('found' | 'hat' | 'pet' | 'ball'), or null for a press on nothing of his. */
  function pointerDown(x, y) {
    ptr.x = x; ptr.y = y; ptr.at = e.now(); ptr.hist = [[x, y, ptr.at]]; ptr.down = true; cat.soloN = 0;
    if (cat.hide && cat.hide.phase !== 'go') {
      if (e.findAt(x, y)) { ptr.down = false; return 'found'; }
      if (cat.hide.phase !== 'gone' && cat.hide.phase !== 'peek') { ptr.down = false; return null; }
      if (ballHit(x, y)) return pickUp();   // in the box: no petting through it; a press on the ball picks it up
      ptr.down = false; return null;
    }
    if (HAT && (e.canPet() || cat.clip === 'fs-hat') && e.catHit(x, y) && e.headHit(y) && !(cat.clip === 'fs-hat' && cat.i >= HAT.fixFrom)) {
      cat.rub = true;
      if (cat.clip !== 'fs-hat') e.play(WD.clips['sit-settle-in'] ? 'sit-settle-in' : 'fs-hat');
      else if (cat.i >= HAT.tiltHold[0]) cat.i = HAT.rubLoop[0];
      e.say('你在揉他的帽子'); return 'hat';
    }
    if (cat.clip === 'fs-sniff' && e.catHit(x, y)) {
      if (HAT && e.headHit(y)) cat.rubAfterSniff = true; else cat.pet = true;
      e.say(cat.rubAfterSniff ? '你在揉他的帽子' : '你在摸他');
      if (cat.rubAfterSniff) cat.rub = true;
      return cat.rubAfterSniff ? 'hat' : 'pet';
    }
    {
      const pc = e.petClipFor();
      if (pc && e.catHit(x, y)) {
        cat.pet = true;
        if (cat.clip !== pc) { cat.petBack = PETBACK[pc] || 'fs-idle'; cat.petDir = 1; e.play(pc); }
        e.say('你在摸他'); return 'pet';
      }
    }
    if (ballHit(x, y)) return pickUp();
    ptr.down = false; return null;   // the desktop's own click: nothing of his was under it
  }
  // ---- input: hold = carrying the paper ball, release = throw
  function pointerUp() {
    if (cat.rub) { cat.rub = false; ptr.down = false; return; }
    if (cat.pet) { cat.pet = false; ptr.down = false; e.heartsGo(); return; }
    ptr.down = false;
    if (!ball.held) return;
    ball.held = false;
    const h = ptr.hist, now = e.now(); let vx = 0, vy = 0; const old = h.find(p => now - p[2] < 120);
    if (old && h.length > 1) { const last = h[h.length - 1], dt = Math.max(16, last[2] - old[2]) / 1000; vx = (last[0] - old[0]) / dt / v.k; vy = (last[1] - old[1]) / dt / v.k; }
    ball.vx = Math.max(-1100, Math.min(1100, vx)); ball.vh = Math.max(-900, Math.min(1100, -vy)); ball.fresh = true; ball.relAt = e.now();
    if (ball.h >= v.CEIL - BR * 2.4 && Math.hypot(ball.vx, ball.vh) < 420) {   // set against the ceiling: it sticks
      ball.ceil = true; ball.h = v.CEIL - BR; ball.vx = 0; ball.vh = 0; ball.sqv = 5;
      ball.x = Math.min(Math.max(ball.x, 140), v.worldW - 140);   // not right into a corner, where he could never get a paw to it
    }
    if (cat.clip === 'nap') ptr.at = e.now();
  }

  Object.assign(e, { pointerMove, pointerDown, pointerUp, ballHit, ballRadius });
}

// F336 Phase C: what the cat sees and where he is drawn (ported from the card engine, template-world.html).
// Every function reads the shared engine state; screen positions are body-window CSS pixels.
import { MAXLEAP, PAPER_NEAR, PETS, PW, REFX, WALLX } from './constants.mjs';

export function installSenses(e) {
  const { WD, K, cat, ball, ptr, paper, view: v } = e;
  const { BR, DRG, DRG_MAX, DRG_MIN, EYE, GROUND, PET, REACH, ring } = K;
  const clip = () => WD.clips[cat.clip];
  const canMove = () => !!e.atlases[1];
  const canClimb = () => !!e.atlases[2];
  function say(text) { if (text !== e.status) e.status = text; }
  function pointerRecent(ms = 1800) { return e.now() - ptr.at < ms; }
  function curFrame() { const c = clip(); return c.frames[Math.min(c.frames.length - 1, Math.max(0, cat.i))]; }
  function drawFacing() { const c = clip(); return c.wall ? cat.mir : (c.abs ? 1 : cat.facing); }
  function wallAnchor() { return cat.wall === 'L' ? WALLX : v.worldW - WALLX; }
  function paperSide() {
    if (!DRG.length || !Number.isFinite(paper.x)) return 0;
    const d = paper.x - cat.x, ad = Math.abs(d);
    return (ad >= PAPER_NEAR - 2 && ad - PW / 2 <= DRG_MAX - 6 && ad + PW / 2 >= DRG_MIN + 6) ? Math.sign(d) : 0;
  }
  // where the current frame is drawn (screen px)
  function catRect() {
    const [, , w, h, ox, oy] = WD.frames[curFrame()], s = WD.scale, fc = drawFacing(), k = v.k;
    const x0 = fc > 0 ? (cat.x + ox - REFX) * k : (cat.x - (ox + w / s - REFX)) * k;
    const y0 = v.floorY + (oy - GROUND) * k - cat.y * k + (cat.sink || 0) * k;
    return [x0, y0, w / s * k, h / s * k];
  }
  function catHit(px, py) { const [x0, y0, w, h] = catRect(); return px >= x0 && px <= x0 + w && py >= y0 && py <= y0 + h; }
  // ---- 摸摸 (11-18, Landy: 「用你的鼠标当那只手」): press on him while he sits facing you = petting him, not picking
  // up the ball. He sits back, leans into your hand, eyes shut, hearts float up; let go and he plays it backwards from the
  // frame he is on and is sitting again at once (11-14 rua: in, loop, out = the same frames played back). The hand drawn
  // in the 11-14 frames is erased (masked edit): your pointer is the hand.
  function canPet() { return !!PET && (cat.clip === 'fs-idle' || cat.clip === 'fs-look' || cat.clip === 'fs-pet'); }
  function petClipFor() { if (clip().petLoop) return cat.clip; const p = PETS[cat.clip]; return p && WD.clips[p] ? p : null; }
  // how fast your hand moves (world px/s over the last ~0.15 s; 0 once it has stopped)
  function ptrSpeed() {
    const h = ptr.hist, now = e.now(), a = h.find(p => now - p[2] < 160), b = h[h.length - 1];
    if (!a || !b || a === b || now - b[2] > 160) return 0;
    return Math.hypot(b[0] - a[0], b[1] - a[1]) / v.k / Math.max(0.05, (b[2] - a[2]) / 1000);   // over at least 50 ms: two events 17 ms apart read a 10 px nudge as a fast hand
  }
  function worldPtr() { return pointerRecent(400) ? [ptr.x / v.k, (v.floorY - ptr.y) / v.k] : null; }   // world x, height above the floor
  function fastSweep() { return pointerRecent(150) && !ptr.down && ptrSpeed() > 1500; }
  function eyeScreen() { const ex = cat.x + (EYE[0] - REFX); return [ex * v.k, v.floorY + (EYE[1] - GROUND) * v.k]; }
  function handNearFace() {
    if (!pointerRecent(2000) || ptr.down) return false;
    const [ex, ey] = eyeScreen();
    return Math.hypot(ptr.x - ex, ptr.y - ey) < 165 * v.k;
  }
  // ---- 揉歪帽子 (Phase A AC-A7, 11-18): press on the top of his head = your hand rubs the beret. Once it is askew it stays
  // askew until he puts it straight with his own paw; a ball thrown meanwhile waits until he has done that (no snap back)
  function headHit(py) {
    const [, , , h, , oy] = WD.frames[curFrame()], s = WD.scale;
    const y0 = v.floorY + (oy - GROUND) * v.k - cat.y * v.k;
    return py <= y0 + h / s * v.k * 0.34;
  }
  // ---- the small brain's questions
  function chaseWanted() { return canMove() && ball.fresh && !ball.held && cat.energy > 0.15 && (!ball.ceil || canClimb()); }
  function ahead() { return (ball.x - cat.x) * cat.facing - REACH; }
  // behind his anchor, not just closer than one reach: a ball right under his nose is still in front of him (11-17: the
  // old test 'ahead() < -REACH/2' read a close ball as behind, and he turned round and round on it)
  function behind() { return (ball.x - cat.x) * cat.facing < -40; }
  // ---- gaze at FS: same ring logic as v1, mirrored when he faces left
  function angDiff(a, b) { let d = a - b; while (d > 180) d -= 360; while (d < -180) d += 360; return Math.abs(d); }
  // only frames looking to the same side as the target: the ring has no up-left frame, and the nearest angle would
  // otherwise be an up-right one (11-16 碳碳: ball up-left, he looked up-right). Near the vertical either side will do.
  function gazeFrame(px, py) {
    const [ex, ey] = eyeScreen(); const dx = px - ex, dy = py - ey;
    if (Math.hypot(dx, dy) < 45 * v.k * 2) return 0;
    const a = Math.atan2(dy, dx) * 180 / Math.PI, side = Math.abs(dx) < Math.abs(dy) * 0.18 ? 0 : Math.sign(dx);
    let best = ring[0], bd = 1e9;
    for (const i of ring) {
      const g = WD.gaze[i], gs = Math.cos(g * Math.PI / 180);
      if (side && gs * side < -0.05) continue;
      const d = angDiff(g, a);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  // after playing with it he keeps an eye on the ball for a while (11-16 碳碳: he used to stare at an empty ceiling)
  function lookTarget() {
    const k = v.k, floorY = v.floorY, now = e.now();
    if (ball.ceil && ball.fresh) return [ball.x * k, floorY - ball.h * k];
    if (ball.held || Math.abs(ball.vx) > 40 || ball.h > BR + 4 || (ball.fresh && now - ball.relAt < 3500)) return [ball.x * k, floorY - ball.h * k];
    if (cat.resume && cat.resume.kind === 'draft' && !cat.resume.looked && !paperSide() && !ball.fresh && now - cat.playedAt > 1500) {
      cat.resume.looked = true; cat.resume.lookUntil = now + 3000;   // the ball has stopped: now he remembers the draft
    }
    cat.lookPaper = false;
    if (cat.resume && now < (cat.resume.lookUntil || 0) && Number.isFinite(paper.x)) {
      cat.lookPaper = true; return [paper.x * k, floorY - 8 * k];   // the draft he left, too far to go back to
    }
    if (now - cat.playedAt < 7000 && Math.abs(ball.x - cat.x) < 900) return [ball.x * k, floorY - ball.h * k];
    if (pointerRecent()) return [ptr.x, ptr.y];
    return null;
  }
  // the hand passing his reach on the way to a lure: where it is worth a pounce (used by the pointer)
  const lureReach = () => REACH + MAXLEAP + 60;

  Object.assign(e, {
    clip, canMove, canClimb, say, pointerRecent, curFrame, drawFacing, wallAnchor, paperSide, catRect, catHit, canPet,
    petClipFor, ptrSpeed, worldPtr, fastSweep, eyeScreen, handNearFace, headHit, chaseWanted, ahead, behind, gazeFrame,
    lookTarget, lureReach,
  });
}

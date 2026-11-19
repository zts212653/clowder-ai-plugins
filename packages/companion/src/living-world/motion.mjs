// F336 Phase C: clip playback, the paws on the ball and the paper, and the ball's physics (ported from the card engine).
import { MAXLEAP, PAPER_NEAR, PW, REFX, SAY, sum } from './constants.mjs';

export function installMotion(e) {
  const { WD, K, cat, ball, ptr, paper, hearts, view: v } = e;
  const { BR, CLB, GROUND, LAND, LEAPW, PAWS, REACH, SP } = K;
  const clip = () => e.clip();
  const say = text => e.say(text);
  const chaseWanted = () => e.chaseWanted();
  const ahead = () => e.ahead();
  const behind = () => e.behind();

  // ---- playback
  function play(name, at = 0) {
    if (name === 'drop') { const dw = WD.clips.drop; cat.fall = cat.y + sum(dw.dy, 0, 15); }
    if (name === 'wall-drop') cat.fall = cat.y;
    if (cat.facing < 0 && WD.clips[name + '-L']) name += '-L';
    if (!at && WD.clips[name].startAt) at = WD.clips[name].startAt;
    if (!/^ss-to-fs/.test(name)) cat.hurry = false;
    cat.last = cat.clip; cat.clip = name; cat.i = at - 1; cat.fixAt = at; cat.acc = 0; cat.loops = 0; cat.since = e.now();
    if (SAY[name] && !(cat.hide && name === 'stalk')) say(SAY[name]);
    // a measured entry: where this clip's first frame sits after the clip it comes from (replaces that frame's own dx/dy)
    const nc = WD.clips[name], ef = nc.entryFrom && nc.entryFrom[cat.last];
    if (ef) cat.fix = [ef[0] - ((nc.dx || [])[at] || 0), ef[1] - ((nc.dy || [])[at] || 0)];
    show();
  }
  function show() {
    const c = clip(); cat.i++;
    if (cat.i >= c.frames.length) {
      if (c.loop) { cat.i = 0; cat.loops++; if (e.onLoop()) return; } else { return ended(); }
    }
    let dx = c.dx ? c.dx[cat.i] : 0, dy = c.dy ? c.dy[cat.i] : 0;
    if (cat.fix && cat.i === (cat.fixAt || 0)) { dx += cat.fix[0]; dy += cat.fix[1]; cat.fix = null; }   // fixAt: the frame play() entered at
    if (cat.spread && cat.spread[cat.i]) { dx += cat.spread[cat.i][0]; dy += cat.spread[cat.i][1]; }
    if (cat.clip === 'climb' && cat.climbLeft > 0) { dy += cat.climbExtra / CLB.frames.length; cat.climbLeft--; }
    if (c.wall) { cat.x += dx * cat.mir; cat.y = Math.max(0, cat.y + dy); wallBeat(); return; }
    // eyes on the ball until he takes off: if it moved, aim the leap at where it is now (11-17 Landy: he pounced the old spot)
    if (cat.clip === 'pounce' && cat.i < 5 && !cat.miss && (chaseWanted() || ball.held)) {
      const r = ahead(), ok = r <= MAXLEAP && !behind();
      // in reach, or right under his nose (shortest leap; it lands under his body and still counts)
      if (ok) cat.leap = Math.max(-REACH * 0.6, r);
      else if (!ball.held) {   // moved out of reach before he left the floor (守望猫 11-17)
        if (cat.i <= 1) { if (behind() && WD.clips['stalk-turn']) return play('stalk-turn'); return play('stalk', 1); }   // still just sinking: go after it (overlap 0.80+)
        cat.leap = Math.max(-REACH * 0.6, Math.min(MAXLEAP, r)); cat.miss = true;   // already wiggling: he goes anyway, misses, and recovers fast
      }
    }
    if (cat.clip === 'pounce' && LEAPW[cat.i]) dx += cat.leap * LEAPW[cat.i];   // carry him through the air so the paws land on the ball
    cat.x += dx * cat.facing; cat.x = Math.min(Math.max(cat.x, 120), v.worldW - 120);
    if (cat.clip === 'pounce' && !cat.hide) pawOnBall();   // the hop into / out of the box is not at the ball
    if (c.drag) dragPaper();
    if (cat.clip === 'ssd-play' && cat.i === SP.tap && !ball.held) {   // the tap: a small roll forward
      const paw = cat.x + SP.reach * cat.facing;
      if (Math.abs(ball.x - paw) < BR * 1.8 && ball.h < BR * 2) { ball.vx = 240 * cat.facing; ball.vh = 120; ball.sqv = 5; }
    }
  }
  // ---- the pounce really lands on the ball. PAWS[i] = where his front paw tip is in frame i (measured on the frames):
  // a clean hit squashes the ball and keeps it under the paws while he kneads; when the paws pull back as he sits up,
  // the paper springs back and rolls out a little. A paw that only clips the back of it slaps it away, and he goes again.
  function pawTip() { const t = PAWS[cat.i]; return t == null ? null : cat.x + t * cat.facing; }
  function pawOnBall() {
    if (cat.i === LAND) {
      const tip = pawTip(); if (tip == null || ball.held || ball.h > BR * 2) return;
      const off = (ball.x - tip) * cat.facing;
      if (off > -BR * 2.2 && off < BR * 1.2) {
        ball.pin = true; ball.pinOff = Math.max(-BR * 0.6, Math.min(BR * 0.3, off)); ball.vx = 0; ball.vh = 0; ball.h = BR; ball.fresh = false; ball.sq = 0; ball.sqv = 9; ball.sqTo = 0.42;
      }
      // the ball is under his body (he had to jump short: it was right under his nose): he lands on it and it squashes
      // where it is (11-17 守望猫: the corner pounce looked like a hit with no reaction)
      else if (off <= -BR * 2.2 && off > -(PAWS[LAND] + BR)) {
        ball.pin = true; ball.pinOff = off; ball.vx = 0; ball.vh = 0; ball.h = BR; ball.fresh = false; ball.sq = 0; ball.sqv = 9; ball.sqTo = 0.42;
      } else if (off >= BR * 1.2 && off < BR * 3) {
        ball.vx = 520 * cat.facing; ball.vh = 260; ball.fresh = true; ball.relAt = e.now(); ball.sqv = 6;
      }
      return;
    }
    if (!ball.pin) return;
    const tip = pawTip();
    if (tip == null || cat.i > LAND && PAWS[cat.i] < PAWS[LAND] - 14) {   // springs back and hops out, still within reach of a tap
      ball.pin = false; ball.vx = 120 * cat.facing; ball.vh = 180; ball.sqTo = 0; ball.sqv = -5; return;
    }
    ball.x = tip + ball.pinOff * cat.facing; ball.sqTo = 0.36 + 0.12 * ((cat.i % 2) ? 1 : 0);   // kneading: pressed a little more every other frame
  }
  function wallBeat() {
    const c = clip();
    // the paw tip of this frame (measured) must be on the ball: frames 1-3 sweep it out along the ceiling
    const tip = c.tips && c.tips[cat.i];
    if (cat.clip === 'swat' && tip && ball.ceil && !ball.held) {
      const px = cat.x + tip[0] * cat.mir, ph = cat.y + tip[1];
      if (Math.hypot(px - ball.x, ph - ball.h) <= BR * 1.1) {
        ball.ceil = false; ball.vx = -260 * cat.mir; ball.vh = -40; ball.fresh = true; ball.relAt = e.now(); ball.sqv = 6; say('啪！拍下来了');
      }
    }
    if ((cat.clip === 'drop' || cat.clip === 'wall-drop') && c.air && c.air[cat.i] && cat.fall) cat.y = Math.max(0, cat.y - cat.fall * c.air[cat.i]);
  }
  function ended() {
    const c = clip(), name = cat.clip;
    if (name === 'sit-settle-in') return play(cat.rub ? 'fs-hat' : 'sit-settle');
    if (name === 'pounce' && ball.pin) { ball.pin = false; ball.sqTo = 0; }
    cat.spread = null;
    if (c.wall) {
      if (Array.isArray(c.travel)) { cat.x += c.travel[0] * cat.mir; cat.y = Math.max(0, cat.y + c.travel[1]); }
      if (name === 'wall-up') cat.x = e.wallAnchor();
      if (name === 'drop') { cat.y = 0; cat.facing = -cat.mir; cat.wall = null; }
      if (name === 'wall-drop') { cat.y = 0; cat.facing = -cat.mir; cat.wall = null; }   // lands facing back into the room, like the ceiling drop
      return e.arrive(c.to, name);
    }
    if (name === 'pounce') { cat.x += (c.travel || 0) * cat.facing; cat.energy = Math.max(0, cat.energy - 0.35); say(ball.fresh ? '差一点点' : '抓到啦'); }
    else if (c.travel) cat.x += c.travel * cat.facing;
    if (c.turn) cat.facing = -cat.facing;   // stalk-turn: he ends up facing the other way
    e.arrive(c.to, name);
  }
  function dragPaper() {
    const t = (clip().drag || [])[cat.i];
    if (t == null) { paper.grab = null; return; }
    const tip = cat.x + t * cat.facing;
    if (paper.grab == null && Math.abs(tip - paper.x) < PW / 2) paper.grab = tip - paper.x;
    if (paper.grab == null) return;
    let nx = tip - paper.grab;
    if ((nx - cat.x) * cat.facing < PAPER_NEAR) nx = cat.x + PAPER_NEAR * cat.facing;
    paper.tilt += (0.02 * cat.facing - paper.tilt) * 0.35; paper.x = nx;
  }
  // above his head, clear of the right ear (11-18 烁烁: a heart sitting on the ear read as a leftover, and stayed after he sat up)
  function spawnHeart() {   // above the head of whatever pose he is in
    const [, , w, , ox, oy] = WD.frames[e.curFrame()], s = WD.scale, fc = e.drawFacing();
    const cx = fc > 0 ? (ox + w / s / 2 - REFX) : (REFX - ox - w / s / 2);
    hearts.push({ x: cat.x + cx + fc * w / s * 0.12 + (e.random() - 0.5) * 50, h: GROUND - oy + cat.y + 12 + e.random() * 25, t: e.now(), dx: (e.random() - 0.3) * 24 });
  }
  function heartsGo() { const now = e.now(); for (const q of hearts) q.t = Math.min(q.t, now - 1200); }   // let go: what is up there fades within 0.3 s
  // ---- ball physics (world units per second)
  function stepBall(dt) {
    const k = v.k, CEIL = v.CEIL;
    ball.sqv += ((ball.sqTo - ball.sq) * 220 - ball.sqv * 11) * dt; ball.sq = Math.max(-0.35, Math.min(1, ball.sq + ball.sqv * dt));
    if (ball.pin) { ball.vx = 0; ball.vh = 0; ball.h = BR; return; }
    if (ball.ceil) { ball.vx = 0; ball.vh = 0; ball.h = CEIL - BR; return; }
    if (ball.held) {
      const wx = ptr.x / k, wh = (v.floorY - ptr.y) / k;
      ball.x = Math.min(Math.max(wx, BR), v.worldW - BR); ball.h = Math.min(CEIL - BR, Math.max(BR, wh)); ball.vx = 0; ball.vh = 0; return;
    }
    ball.vh -= 2600 * dt; ball.x += ball.vx * dt; ball.h += ball.vh * dt;
    if (ball.h > CEIL - BR) { ball.h = CEIL - BR; if (ball.vh > 0) ball.vh = -ball.vh * 0.3; }
    if (ball.h <= BR) {
      ball.h = BR; if (ball.vh < -220) ball.vh = -ball.vh * 0.32; else ball.vh = 0;
      const dec = 900 * dt; ball.vx = Math.abs(ball.vx) <= dec ? 0 : ball.vx - Math.sign(ball.vx) * dec;
    }
    if (ball.x < BR) { ball.x = BR; ball.vx = Math.abs(ball.vx) * 0.35; }
    if (ball.x > v.worldW - BR) { ball.x = v.worldW - BR; ball.vx = -Math.abs(ball.vx) * 0.35; }
    ball.spin += ball.vx * dt / BR;
  }

  Object.assign(e, { play, show, ended, pawOnBall, wallBeat, dragPaper, spawnHeart, heartsGo, stepBall });
}

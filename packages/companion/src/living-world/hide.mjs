// F336 Phase C: 躲猫猫 in the cardboard box (ported from the card engine; the box stands on the floor by the left wall).
// On the desktop the box itself never takes a click: only his head, while it is up over the rim, is clickable.
import { BOX, LIFT, LIFT_ARC, PK, RIM, SINK_HIDE, ease } from './constants.mjs';

export function installHide(e) {
  const { WD, K, cat, ball, ptr, view: v } = e;
  const { GROUND, LAND } = K;
  const play = (name, at) => e.play(name, at);
  const show = () => e.show();
  const say = text => e.say(text);
  const chaseWanted = () => e.chaseWanted();

  function boxInner() { return [BOX.x - BOX.w / 2 + 6, BOX.x + BOX.w / 2 - 6]; }
  function rimY() { return v.floorY - RIM * v.k; }
  function spriteBottom(f) { const [, , , h, , oy] = WD.frames[f]; return GROUND - (oy + h / WD.scale); }
  function tweenSink(to, ms, back) { const h = cat.hide; h.tw = { from: cat.sink || 0, to, t0: e.now(), ms, back }; }
  function stepTween(now) {
    const t = cat.hide.tw; if (!t) return true;
    const u = (now - t.t0) / t.ms; cat.sink = t.from + (t.to - t.from) * ease(u, t.back);
    if (u >= 1) { cat.sink = t.to; cat.hide.tw = null; return true; }
    return false;
  }
  // your hand moving fast near the box (resting, or creeping up slowly, does not scare him)
  function handNearBox() {
    if (!e.pointerRecent(250) || e.ptrSpeed() < 450) return false;
    return Math.abs(ptr.x / v.k - BOX.x) < BOX.w / 2 + 260 && ptr.y > rimY() - 330 * v.k;
  }
  function boxHeadHit(px, py) { return e.catHit(px, py) && py < rimY(); }
  function startHide() {
    const d = BOX.x - cat.x; cat.facing = d >= 0 ? 1 : -1; cat.hide = { phase: 'go' }; cat.lastHide = 1;
    if (Math.abs(d) < 200 && WD.clips['fs-to-crouch']) { play('fs-to-crouch'); say('他盯上了纸箱，屁股扭一扭'); }
    else { play('fs-to-st'); say('他看了看纸箱，悄悄溜过去'); }
  }
  function hopIn() {
    const h = cat.hide; h.phase = 'in'; h.inBox = false;
    cat.leap = (BOX.x - cat.x) * cat.facing + 2; cat.miss = true; cat.y = 0; play('pounce', 4); say('嗖，他跳进了纸箱'); return true;
  }
  // out of the box: a quick duck if he was showing, then the pounce from its crouch, rising out over the rim
  function hopOut(why) {
    const h = cat.hide; h.phase = 'out'; h.why = why; h.inBox = true;
    const dir = why === 'ball' ? Math.sign(ball.x - cat.x) || 1 : why === 'found' ? Math.sign(ptr.x / v.k - cat.x) || 1 : 1;
    cat.facing = dir; cat.leap = 150; cat.miss = true;
    // hidden at this point: move to the middle first, so the side-on crouch (380 wide) is inside the box (碳碳 11-18: from the
    // ends of the box, where he peeks, its back stuck out through the side walls)
    cat.x = BOX.x + dir * 15; cat.sink = SINK_HIDE; tweenSink(0, 220); play('pounce', 4);   // up over the crouch frames; clear of the rim by take-off
    say(why === 'found' ? '他从纸箱里蹦出来扑你' : why === 'ball' ? '听见纸团的动静，他从纸箱里蹦出来' : '没人来找他，他自己从纸箱里蹦出来了');
    return true;
  }
  function stepHide(now) {
    const h = cat.hide;
    if (h.phase === 'go') { if (chaseWanted() || ball.held) { cat.hide = null; } return false; }   // the ball first: the normal chase takes over
    if (h.phase === 'in') {   // the hop: lifted over the rim; he is in the box from the frame where all of him is above it
      const was = spriteBottom(e.curFrame()) + cat.y; show(); const L = LIFT_ARC[cat.i] || 0; cat.y = LIFT * L;
      if (!h.inBox && spriteBottom(e.curFrame()) + cat.y >= RIM + 2) h.inBox = true;
      // landing: the height he still had (lift + the in-air pose) becomes where the fall into the box starts, so he drops
      // in continuously (碳碳 11-18: the body went down 133 px in one frame)
      if (cat.i >= LAND) {
        cat.y = 0; h.inBox = true; h.phase = 'sink'; cat.sink = -Math.max(0, was - spriteBottom(e.curFrame()));
        tweenSink(SINK_HIDE, 560, 'in'); say('他缩进纸箱里藏起来了');
      }
      return true;
    }
    if (h.phase === 'sink') {
      if (cat.i < LAND + 4) cat.i++;
      cat.x += (BOX.x - cat.x) * 0.3;
      if (!stepTween(now)) return true;
      h.phase = 'gone'; h.n = 0; h.until = now + 900 + e.random() * 700; cat.clip = 'fs-idle'; cat.i = 0; cat.facing = 1; cat.x = BOX.x - 70; return true;
    }
    if (h.phase === 'out') {
      show(); const j = cat.i; stepTween(now); cat.y = LIFT * (LIFT_ARC[j] || 0);
      if (h.inBox && spriteBottom(e.curFrame()) + cat.y - cat.sink >= RIM + 2) h.inBox = false;
      if (j >= LAND) { cat.y = 0; cat.sink = 0; cat.hide = null; }
      return true;
    }
    // in the box: the head comes up and goes down (cat.sink, eased); fs-idle frames, or looking at your hand
    const idle = () => { if (now - (h.fAt || 0) > 180) { h.fAt = now; cat.clip = 'fs-idle'; cat.i = (cat.i + 1) % WD.clips['fs-idle'].frames.length; } };
    const look = () => {
      if (e.pointerRecent(1200) && !ptr.down) { cat.clip = 'fs-look'; cat.i = e.gazeFrame(ptr.x, ptr.y - (cat.sink || 0) * v.k); return true; }
      if (cat.clip === 'fs-look') { cat.clip = 'fs-idle'; cat.i = 0; }
      idle(); return false;
    };
    const done = stepTween(now);
    if (h.phase === 'gone') {
      if (chaseWanted()) return hopOut('ball');
      if (handNearBox()) h.until = Math.max(h.until, now + 1000);
      if (now < h.until || !done) return true;
      if (h.n >= 3) return hopOut('self');
      h.n++; cat.x = BOX.x + (h.n % 2 ? 62 : -70); cat.clip = 'fs-idle'; cat.i = 0; h.phase = 'peek'; h.p = 'ears';
      tweenSink(PK.ears, 420, true); h.t = now + 700 + e.random() * 500; say('纸箱边上冒出两只耳朵'); return true;
    }
    if (h.p === 'found') { if (done && now > h.t) return hopOut('found'); return true; }
    if (h.p !== 'duck' && (chaseWanted() || handNearBox())) {
      h.p = 'duck'; h.why = chaseWanted() ? 'ball' : null; tweenSink(SINK_HIDE, 140);
      if (!h.why) say('被你发现了，他嗖地缩回去');
      return true;
    }
    switch (h.p) {
      case 'ears':
        idle();
        if (done && now > h.t) { h.p = 'eyes'; tweenSink(PK.eyes, 320, true); h.t = now + 1300 + e.random() * 900; say(h.n > 1 ? '他又探出头来偷看你' : '他从纸箱里探出头，偷偷看你'); }
        break;
      case 'eyes':
        if (look()) say('他盯着你的手');
        if (done && now > h.t) {
          if (e.random() < 0.6) { h.p = 'full'; tweenSink(PK.full, 300, true); h.t = now + 900 + e.random() * 700; }
          else { h.p = 'duck'; tweenSink(SINK_HIDE, 180); }
        }
        break;
      case 'full': look(); if (done && now > h.t) { h.p = 'duck'; tweenSink(SINK_HIDE, 180); } break;
      case 'duck': idle(); if (done) { h.phase = 'gone'; h.p = null; h.until = now + (h.why ? 250 : 1100 + e.random() * 900); } break;
    }
    return true;
  }
  /** A press on his head while he peeks = found: he ducks, then springs out at you. */
  function findAt(px, py) {
    const h = cat.hide;
    if (!h || h.phase !== 'peek' || h.p === 'found' || h.p === 'duck' || !boxHeadHit(px, py)) return false;
    h.p = 'found'; h.t = e.now() + 250; tweenSink(SINK_HIDE, 110); say('找到你啦！');
    return true;
  }
  // the box, in two parts: behind him while he is in it (opening, back and side flaps), and its front wall over him
  function drawBox(ctx, front) {
    const k = v.k, L = (BOX.x - BOX.w / 2) * k, R = (BOX.x + BOX.w / 2) * k, bot = v.floorY - BOX.back * k, F = bot - BOX.rim * k, B = F - BOX.d * k, ln = Math.max(1, 1.3 * k);
    ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(112,72,40,0.36)'; ctx.lineWidth = ln;
    const poly = (pts, fill) => {
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
      ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.stroke();
    };
    if (!front) {
      ctx.fillStyle = 'rgba(120,80,50,0.16)'; ctx.beginPath(); ctx.ellipse((L + R) / 2, bot + 2 * k, (R - L) * 0.56, 16 * k, 0, 0, Math.PI * 2); ctx.fill();
      poly([[L + 6 * k, B], [R - 6 * k, B], [R - 26 * k, B - 66 * k], [L + 24 * k, B - 62 * k]], '#d6b083');                 // back flap, its inside toward you
      poly([[L, F], [L, B], [L - 50 * k, B - 34 * k], [L - 58 * k, F - 14 * k]], '#c99862'); poly([[R, F], [R, B], [R + 54 * k, B - 30 * k], [R + 60 * k, F - 12 * k]], '#c3915b');   // side flaps, open
      const g = ctx.createLinearGradient(0, B, 0, F); g.addColorStop(0, '#a77649'); g.addColorStop(1, '#6d4526'); ctx.fillStyle = g; ctx.fillRect(L, B, R - L, F - B); ctx.strokeRect(L, B, R - L, F - B);
      return;
    }
    const g = ctx.createLinearGradient(0, F, 0, bot); g.addColorStop(0, '#d09a62'); g.addColorStop(1, '#b57c47'); ctx.fillStyle = g; ctx.fillRect(L, F, R - L, bot - F); ctx.strokeRect(L, F, R - L, bot - F);
    poly([[L, F], [R, F], [R - 7 * k, F + 44 * k], [L + 7 * k, F + 44 * k]], '#dcab74');                                 // front flap, folded down
    ctx.strokeStyle = 'rgba(255,236,206,0.55)'; ctx.lineWidth = Math.max(1, 2.2 * k); ctx.beginPath(); ctx.moveTo(L + 4 * k, F + 2.5 * k); ctx.lineTo(R - 4 * k, F + 2.5 * k); ctx.stroke(); ctx.lineWidth = ln;   // the fold catches the light
    // his paw print, stamped on the front (宪宪的纸箱)
    const px = (L + R) / 2 + BOX.w * 0.22 * k, py = F + (44 + (BOX.rim - 44) * 0.55) * k, u = 7 * k;
    ctx.fillStyle = 'rgba(122,74,40,0.42)'; ctx.save(); ctx.translate(px, py); ctx.rotate(-0.18);
    ctx.beginPath(); ctx.ellipse(0, u * 0.9, u * 1.5, u * 1.2, 0, 0, Math.PI * 2); ctx.fill();
    for (const [tx, ty] of [[-1.55, -0.6], [-0.55, -1.45], [0.55, -1.45], [1.55, -0.6]]) { ctx.beginPath(); ctx.ellipse(tx * u, ty * u, u * 0.52, u * 0.62, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }
  /** The box's outline in screen px (flaps folded): where he is when none of him shows. */
  function boxRect() {
    const k = v.k, top = rimY() - BOX.d * k;
    return [(BOX.x - BOX.w / 2) * k, top, BOX.w * k, v.floorY - BOX.back * k - top];
  }

  Object.assign(e, { boxInner, rimY, stepTween, startHide, hopIn, hopOut, stepHide, findAt, drawBox, boxRect });
}

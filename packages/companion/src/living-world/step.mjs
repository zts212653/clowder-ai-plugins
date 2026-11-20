// F336 Phase C: one sprite step of the cat and how long it lasts (ported from the card engine).
import { BOX, MAXLEAP, sum } from './constants.mjs';

export function installStep(e) {
  const { WD, K, cat, ball, ptr, paper, view: v } = e;
  const { BR, CHG, CHG_RISE, CLB, GO, HAT, LAND, REACH, SHM, STK, SWT, WUP, ring } = K;
  const clip = () => e.clip();
  const play = (name, at) => e.play(name, at);
  const show = () => e.show();
  const say = text => e.say(text);
  const arrive = (hub, from) => e.arrive(hub, from);
  const chaseWanted = () => e.chaseWanted();
  const handNearFace = () => e.handNearFace();
  const ptrSpeed = () => e.ptrSpeed();

  // ---- per tick
  function stepCat(now) {
    if (cat.hide && e.stepHide(now)) return;
    const c = clip();
    if (cat.clip === 'fs-hat') {
      const R = HAT.rubLoop, T = HAT.tiltHold, F = HAT.fixFrom, n = HAT.frames.length;
      if (cat.rub) {   // pushed askew, then rubbing back and forth on the askew frames
        if (cat.i < R[0]) { cat.i++; cat.rubDir = 1; return; }
        cat.rubDir = cat.rubDir || 1; if (cat.i >= R[1]) cat.rubDir = -1; else if (cat.i <= R[0]) cat.rubDir = 1; cat.i += cat.rubDir; return;
      }
      if (cat.i < R[0]) { if (cat.i > 0) { cat.i--; return; } play((WD.clips['sit-settle'] ? 'sit-settle' : 'fs-idle')); return; }      // let go before the beret moved: back to sitting
      if (cat.i < T[0]) { cat.i++; return; }                                          // let go: the hand leaves, the beret stays askew
      if (cat.i < F) {
        if (cat.i === T[0] && !cat.tiltUntil) { cat.tiltUntil = now + 2500 + e.random() * 3500; say('帽子歪了'); }
        const hurry = chaseWanted() || ball.held;                                  // the ball can wait: the beret first
        if (now < cat.tiltUntil && !hurry) { cat.i = cat.i < T[1] ? cat.i + 1 : T[0]; return; }
        cat.tiltUntil = 0; cat.i = F; say('他抬爪把帽子扶正'); return;
      }
      if (cat.i < n - 1) { cat.i++; return; }
      play(WD.clips['sit-settle'] ? 'sit-settle' : 'fs-idle'); return;   // settles back into the slimmer sit (quick when the ball is waiting, then after it)
    }
    if (c.petLoop) {
      const L = c.petLoop;
      if (cat.pet) {
        if (cat.i < L[0]) cat.i++;
        else if (c.pingpong) { cat.petDir = cat.petDir || 1; if (cat.i >= L[1]) cat.petDir = -1; else if (cat.i <= L[0]) cat.petDir = 1; cat.i += cat.petDir; }
        else cat.i = cat.i < L[1] ? cat.i + 1 : L[0];
        if (cat.i >= L[0] && e.random() < 0.4) e.spawnHeart();
        if (cat.i >= L[0]) say(c.petSay || '他眯着眼往你手里蹭');
        return;
      }
      if (cat.i > 0) { cat.i--; return; }
      const back = cat.petBack || 'fs-idle'; cat.petBack = null; cat.pauseUntil = now + 900; play(back); say(back === 'nap' ? '他又睡着了' : '他坐好了，看着你'); return;
    }
    // your hand held out slowly near his face (Phase A AC-A6): he leans in and sniffs it; it goes away or speeds off: he sits back
    if (cat.clip === 'fs-sniff') {
      const H = c.sniffHold;
      // pressed while sniffing: he settles, then your hand (pet, or the beret if it was his head)
      if (cat.pet || cat.rubAfterSniff) {
        if (cat.i > 0) { cat.i--; return; }
        if (cat.rubAfterSniff) { cat.rubAfterSniff = false; return play(cat.rub ? (WD.clips['sit-settle-in'] ? 'sit-settle-in' : 'fs-hat') : 'fs-idle'); }
        cat.petBack = 'fs-idle'; cat.petDir = 1; return play('fs-pet');
      }
      if (handNearFace() && ptrSpeed() < 900 && !chaseWanted() && !ball.held) {
        cat.leftAt = 0; if (cat.i < H[0]) { cat.i++; return; }
        cat.sDir = cat.sDir || 1; if (cat.i >= H[1]) cat.sDir = -1; else if (cat.i <= H[0]) cat.sDir = 1; cat.i += cat.sDir; say('他凑过来闻你的手'); return;
      }
      cat.leftAt = cat.leftAt || now; if (now - cat.leftAt < 350 && !chaseWanted() && !ball.held) return;
      if (cat.i > 0) { cat.i--; return; }
      cat.leftAt = 0; cat.pauseUntil = now + 700; play('fs-idle'); if (chaseWanted()) arrive('FS'); return;
    }
    // a fast swipe went past (Phase A AC-A6): he is down in a hunting crouch, eyes on where it went; another swipe in reach
    // and he pounces at it; nothing more and he gets up again
    // still getting down when the next swipe goes by: keep it, he goes for it as soon as he is down
    if (cat.clip === 'crouch-wait' && cat.lure && cat.lure.next && now - cat.lure.next.at < 1200) {
      const nx = cat.lure.next.x;
      // forwards only (烁烁 11-18: a hand inside his reach gave a negative leap: he slid backwards in the air)
      cat.leap = Math.max(30, Math.min(MAXLEAP, (nx - cat.x) * cat.facing - REACH)); cat.miss = true; cat.lure = null; play('pounce', 4); say('他扑向你的手'); return;
    }
    if (cat.clip === 'crouch-wait') {
      if (chaseWanted() || ball.held) { cat.lure = null; return arrive('CROUCH'); }
      if (!cat.lure || now - cat.lure.at > 2600) { cat.lure = null; return play('crouch-to-fs'); }
      // (no settle: its first frame is the hat clip's end, not the pet's; 碳碳 11-18)
      cat.wDir = cat.wDir || -1; if (cat.i >= c.frames.length - 1) cat.wDir = -1; else if (cat.i <= 0) cat.wDir = 1; cat.i += cat.wDir; if (cat.i < 0) cat.i = 0;
      say('他压低身子，屁股扭来扭去'); return;
    }
    if ((cat.clip === 'fs-idle' || cat.clip === 'fs-look') && e.canMove() && !ball.held && !chaseWanted() && !ball.fresh) {
      // a hand over the top of his head is for the beret (Landy 11-18: 「现在怎么摸歪他的帽子？」)
      if (WD.clips['fs-sniff'] && handNearFace() && ptrSpeed() < 260 && !(e.catHit(ptr.x, ptr.y) && e.headHit(ptr.y))) {
        cat.nearSince = cat.nearSince || now;
        if (now - cat.nearSince > 450) { cat.nearSince = 0; cat.sDir = 1; return play('fs-sniff'); }
      } else cat.nearSince = 0;
      const lw = e.worldPtr();
      if (WD.clips['crouch-wait'] && lw && e.fastSweep() && Math.abs(lw[0] - cat.x) < 700 && lw[1] < 300) {
        cat.lure = { at: now };
        { const h = ptr.hist, d = h.length > 1 ? h[h.length - 1][0] - h[0][0] : lw[0] - cat.x; cat.facing = d >= 0 ? 1 : -1; }
        cat.wDir = -1; say('有什么东西嗖地过去了'); return play('fs-to-crouch');
      }
    }
    if (cat.clip === 'fs-idle' || cat.clip === 'fs-look') {
      const t = e.lookTarget();
      if (t) {
        cat.clip = 'fs-look';
        const tgt = e.gazeFrame(t[0], t[1]);
        if (cat.lookI !== tgt) {
          if (WD.gaze[cat.lookI] === null || WD.gaze[tgt] === null) cat.lookI = tgt;
          else {
            const ia = ring.indexOf(cat.lookI), ib = ring.indexOf(tgt), n = ring.length, fw = (ib - ia + n) % n, bw = (ia - ib + n) % n;
            cat.lookI = Math.min(fw, bw) > 3 ? tgt : ring[(ia + (fw <= bw ? 1 : n - 1)) % n];
          }
        }
        cat.i = cat.lookI;
        say(cat.lookPaper ? '他回头看了一眼没看完的草稿' : ball.held ? '他盯着你手里的纸团'
          : ball.h > BR + 4 || Math.abs(ball.vx) > 40 ? '他看着纸团飞' : (e.pointerRecent() ? '他在看你的鼠标' : '他还盯着纸团'));
        if (chaseWanted() && (ball.ceil ? e.now() - ball.relAt > 1200 : Math.abs(ball.vx) < 260 && ball.h <= BR + 2)) { cat.lookI = 0; arrive('FS'); }
        return;
      }
      if (cat.clip === 'fs-look') { cat.clip = 'fs-idle'; cat.i = 0; cat.lookI = 0; cat.pauseUntil = now + 1200 + e.random() * 1500; say('他又看回来了'); return; }
      if (now < cat.pauseUntil) { cat.i = 0; return; }
      show(); return;
    }
    if (cat.clip === 'ss-idle' && cat.i % 4 === 3 && e.ssUrgent()) return;
    // his own things break off for the ball, at a frame close to the pose they started from
    // (FS: back to watching first, so his head turns to the ball before he gets up, like any time he spots it;
    // 11-17 烁烁: straight into the chase cut from the head-down draft pose to the turned get-up in one frame)
    if (c.exits && (chaseWanted() || ball.held) && c.exits.includes(cat.i)) {
      paper.grab = null;
      // keep what he was doing and how far he got (Phase A AC-A5: after the ball he goes back to it)
      const kind = /^fs-draft/.test(cat.clip) ? (cat.i < 10 ? 'draft' : null) : cat.clip === 'ss-groom' ? 'groom' : null;
      cat.resume = kind ? { kind, i: cat.i, at: now, facing: cat.facing } : null;   // draft past frame 10: the pull is done, nothing left to go back to
      if (c.frm === 'FS') { cat.pauseUntil = 0; return play('fs-idle'); }
      if (c.frm === 'SS') return e.ssGo();
      if (c.frm === 'LOAF') return play('loaf-to-ss');
    }
    if (cat.clip === 'ssd-play' && cat.i % 4 === 3 && (chaseWanted() || ball.held)) return play('ssd-to-ss');
    if (cat.clip === 'stalk' && cat.wall) {
      if (!ball.ceil) { cat.wall = null; }                            // the ball came down meanwhile: back to a floor chase
      else if (cat.i === (WUP.go || 0)) {
        const start = e.wallAnchor() - sum(WUP.dx) * cat.mir;   // where he must spring from
        const r = (start - cat.x) * cat.facing;
        if (r <= Math.abs(sum(STK.dx))) {
          cat.spread = {}; for (let j = 0; j < 6; j++) cat.spread[j] = [Math.max(-40, r) / 6, 0];
          let yIn = 0; for (const value of WUP.dy) yIn = Math.max(0, yIn + value);
          yIn = Math.max(0, yIn + (WUP.travel || [0, 0])[1]) + (CLB.entry ? CLB.entry[1] : CLB.dy[0]);   // his height as the climb starts
          const need0 = v.HANGY - CHG_RISE - yIn, n = Math.max(1, Math.round(need0 / CLB.cycle));
          cat.climbExtra = need0 - n * CLB.cycle; cat.climbLeft = CLB.frames.length;   // whole cycles; the remainder is shared out over the first cycle
          return play('wall-up');
        }
        show(); return;
      } else { show(); return; }
    }
    // the ball came down while he was still on the wall: jump back down from climb pose 0 instead of going on up
    if (cat.clip === 'climb' && cat.i === 0 && (!ball.ceil || ball.held) && WD.clips['wall-drop']) {
      cat.spread = null; cat.climbLeft = 0; say('纸团被拿下来了，他从墙上跳下来'); return play('wall-drop');
    }
    if (cat.clip === 'climb' && cat.i === CLB.go) {
      const need = v.HANGY - CHG_RISE - cat.y;                        // whole cycles were set up at the wall: swing up when it is ~0
      if (need <= CLB.cycle * 0.5) {
        cat.spread = null; say('他够到天花板了');
        if (CHG.fromClimb) cat.fix = [CHG.fromClimb[0] - CHG.dx[0], CHG.fromClimb[1] - CHG.dy[0]];
        return play('climb-hang');
      }
    }
    if (cat.clip === 'shimmy') {
      const g = (SHM.goList || [[SHM.go, SWT.dx[0], SWT.dy[0]]]).find(entry => entry[0] === cat.i);
      if (g) {
        if (!ball.ceil || ball.held) return play('drop');
        const gap = (cat.x + g[1] * cat.mir - ball.x) * cat.mir - SWT.reach;
        if (gap <= BR * 0.9) { cat.fix = [g[1] - SWT.dx[0], g[2] - SWT.dy[0]]; say('他伸爪去够纸团'); return play('swat'); }
      }
    }
    // one stalk cycle (4 poses) goes further than one leap, so he weighs the pounce twice a cycle: poses GO and go2
    if (cat.clip === 'stalk' && !cat.wall && (cat.i === GO || cat.i === STK.go2)) {
      const r = e.ahead(); cat.miss = false;
      // at the step the pounce starts from: sink lower and pounce once the rest fits in one leap. A cat that loses the
      // ball (taken away, or now behind him) still commits to the pounce he was set for, but it is a miss: he recovers
      // fast and turns to find it instead of playing out the catch on the air.
      // the ball is behind him (snatched away, 11-16 碳碳/烁烁: he pounced at nothing): whip round on the spot
      if (WD.clips['stalk-turn'] && e.behind() && (chaseWanted() || ball.held)) { say('纸团跑到身后了，他一下转过身'); return play('stalk-turn'); }
      // walking into a wall (not away from it: after the jump down from the wall he stands there facing it, then turns)
      if (cat.hide && cat.hide.phase === 'go') { if ((BOX.x - cat.x) * cat.facing <= MAXLEAP + 5) { e.hopIn(); return; } show(); return; }   // on his way to the box: hop in once it is one leap away
      const atWall = (cat.x < 200 && cat.facing < 0) || (cat.x > v.worldW - 200 && cat.facing > 0);
      if (ball.held && !e.behind() && !atWall) { show(); return; }   // your hand still has it, ahead: keep creeping, eyes on it
      if (!chaseWanted() || e.behind() || atWall) { cat.leap = 0; cat.miss = !chaseWanted() || e.behind(); return play('pounce'); }
      // a ball closer than his normal landing: shorten the leap (down to 0.6 of a reach) so the paws come down on it
      // instead of past it (11-16 烁烁: near ball, he overshot and then snapped back)
      if (r <= MAXLEAP) { cat.leap = Math.max(-REACH * 0.6, r); return play('pounce'); }
    }
    show();
  }
  // urgency: after a miss the landing and the turn back play quicker; after the swat hits, he lets go sooner
  function frameMs() {
    const c = clip();
    if (cat.hide) {
      const ph = cat.hide.phase;
      if (ph === 'gone' || ph === 'peek' || (ph === 'sink' && cat.hide.tw)) return 30;
      if (ph === 'go' && cat.clip === 'stalk') return c.ms * 0.6;
      if (ph === 'in' || ph === 'out') return 110;
    }
    if (cat.clip === 'sit-settle' && (chaseWanted() || ball.held)) return 35;
    if (cat.clip === 'fs-hat') return (cat.i >= c.fixFrom && (chaseWanted() || ball.held)) ? c.ms * 0.6 : c.ms;
    // let go: quick back, but frames 0-3 (tail changes side, strawberry paws tuck in, as drawn in the 11-14 clip) at a pace
    // you can follow; no cross-fade between poses (11-18 烁烁: two half-clear cats = a see-through body and four eyes)
    if (c.petLoop) return cat.pet ? c.ms : (cat.clip === 'fs-pet' && cat.i <= 2 ? 110 : 55);
    if (cat.clip === 'fs-sniff') return (cat.pet || cat.rubAfterSniff) ? 40 : (handNearFace() ? c.ms : 70);
    if (cat.clip === 'crouch-wait') return 130;
    if (cat.lure && /^fs-to-crouch/.test(cat.clip)) return (c.msl ? c.msl[Math.min(c.msl.length - 1, Math.max(0, cat.i))] : c.ms) * 0.7;
    if (cat.clip === 'stalk' && cat.wall) return c.ms * 0.77;
    // floor stalk: the last steps before the pounce slow down (creeping in, taking aim: 11-17 碳碳 "no beat to aim before
    // the leap"), and the first steps start a little slower; only the timing changes, the steps (dx) stay as measured
    if (cat.clip === 'stalk' && !cat.miss && chaseWanted()) {
      const r = e.ahead();
      if (r <= MAXLEAP + 100) return c.ms * 1.4;
      if (cat.loops === 0 && cat.i < 2) return c.ms * 1.2;
    }
    let ms = cat.clip === 'fs-look' ? 70 : (c.msl ? c.msl[Math.min(c.msl.length - 1, Math.max(0, cat.i))] : c.ms);
    if (cat.miss && (cat.clip === 'pounce' && cat.i > LAND || /^(ssd-to-ss|ss-to-fs|fs-to-st)/.test(cat.clip))) ms *= 0.6;
    if (cat.clip === 'swat' && !ball.ceil && cat.i > Math.max(...(SWT.hits || [0]))) ms *= 0.55;
    // the ball came while he sat sideways (grooming, or looking at nothing): the turn back to the front is hurried (11-17 烁烁:
    // 2.4 s of turning away from a ball that lies right ahead of him). A side sit has no direct get-up into the chase yet.
    if (cat.hurry && /^ss-to-fs/.test(cat.clip)) ms *= 0.55;
    return ms;
  }

  Object.assign(e, { stepCat, frameMs });
}

// F336 Phase C: the small brain (ported from the card engine): called whenever he arrives at a pose, or finishes one loop
// of an idle. In-session interruptions keep cat.resume for 120 s; a reopened body is restored by scene.mjs instead, and
// an activity that restore put off for the beret waits in cat.restore, with no clock, until he has put it straight.
// With the owner's 自主活动 off (e.behaviorEnabled, from the Host's body-preferences) he starts nothing by himself: no
// activity of his own, no going back to one the ball broke off, no fetching the ball on his own, no daydream or groom on
// waking. He keeps to his idle and rest poses, still answers your hand and a thrown ball, and whatever is already under
// way (a restored one too) plays to its end.
import { MAXLEAP, REACH_FROM_WALL } from './constants.mjs';

export const IN_SESSION_RESUME_MS = 120000;

export function installBrain(e) {
  const { WD, K, cat, ball, ptr, view: v } = e;
  const { BR, CLB, NEAR, REACH, SHM, SP, SWT } = K;
  const play = (name, at) => e.play(name, at);
  const say = text => e.say(text);
  const chaseWanted = () => e.chaseWanted();
  const pointerRecent = ms => e.pointerRecent(ms);
  const canMove = () => e.canMove();
  const ownLife = () => e.behaviorEnabled;

  function arrive(hub, from) {
    if (hub === 'FS') {
      if (chaseWanted() && ball.ceil) {
        { const dR = v.worldW - ball.x, dL = ball.x, near = dR <= dL ? 'R' : 'L', far = near === 'R' ? 'L' : 'R'; cat.wall = Math.min(dR, dL) >= REACH_FROM_WALL ? near : far; }
        cat.mir = cat.wall === 'R' ? 1 : -1; cat.facing = cat.mir; say('纸团粘在天花板上了，他要爬上去');
        return play(WD.clips['fs-to-st-up'] ? 'fs-to-st-up' : 'fs-to-st');
      }
      if (chaseWanted()) {
        if (Math.abs(ball.x - cat.x) >= NEAR) {
          cat.facing = ball.x >= cat.x ? 1 : -1;
          // close enough for one leap from where he sits (11-16 碳碳/烁烁: near ball, he treadmilled 3 s): turn, crouch, pounce
          if (WD.clips['fs-to-crouch'] && Math.abs(ball.x - cat.x) - REACH <= MAXLEAP) { say('纸团就在跟前，他压低身子准备扑'); return play('fs-to-crouch'); }
          return play('fs-to-st');
        }
        ball.fresh = false; say('纸团就在他跟前');
      }
      cat.miss = false; cat.pauseUntil = e.now() + 800;
      return play('fs-idle');
    }
    if (hub === 'STALK') {   // down from the wall facing it, the ball behind him: turn straight round (overlap 0.83)
      if ((from === 'wall-drop' || from === 'drop') && WD.clips['stalk-turn'] && (ball.x - cat.x) * cat.facing < 0) { say('他一转身去追纸团'); return play('stalk-turn'); }
      return play('stalk');
    }
    if (hub === 'CROUCH' && cat.hide && cat.hide.phase === 'go') return e.hopIn();
    if (hub === 'CROUCH' && cat.lure && !chaseWanted() && !ball.held && WD.clips['crouch-wait']) {
      cat.lure.at = e.now(); return play('crouch-wait', WD.clips['crouch-wait'].frames.length - 1);
    }
    if (hub === 'CROUCH') {
      const r = e.ahead(); cat.miss = !chaseWanted();
      // the ball moved while he crouched (11-17 Landy): behind him -> whip round; further away -> go after it; else pounce
      if (chaseWanted() && e.behind() && WD.clips['stalk-turn']) return play('stalk-turn');
      if (chaseWanted() && r > MAXLEAP) return play('stalk', 2);
      cat.leap = Math.max(-REACH * 0.6, Math.min(MAXLEAP, r)); return play('pounce', 4);   // the crouch already sank and wiggled
    }
    if (hub === 'CLIMB') {
      say('他顺着墙往上爬');
      if (CLB.entry) cat.fix = [CLB.entry[0] - CLB.dx[0], CLB.entry[1] - CLB.dy[0]];
      return play('climb');
    }
    if (hub === 'HANG') {
      if (!ball.ceil || ball.held) return play('drop');
      const swAt = cat.x + ((SWT.hangEntry || [0])[0]) * cat.mir;       // where his anchor will be once the swat starts
      const gap = (swAt - ball.x) * cat.mir - SWT.reach;                 // how far the ball still is beyond his swipe
      if (gap > BR * 0.9) { say('他挂在天花板上，一把一把挪过去'); return play('shimmy', SHM.enterAt); }
      cat.fix = [(SWT.hangEntry || [0, 0])[0] - SWT.dx[0], (SWT.hangEntry || [0, 0])[1] - SWT.dy[0]]; say('他伸爪去够纸团'); return play('swat');
    }
    if (hub === 'DROP') return play('drop');
    // a cat that has lost the ball, or has just finished with it, does not sit on in the side pose (its head is up,
    // looking at nothing): he turns back to the front, where his eyes can find the ball
    if (hub === 'SS') {
      const want = cat.want; cat.want = null;
      if (chaseWanted() || ball.held || from === 'ssd-to-ss') return ssGo();
      // a groom: he turned to the side for it, or he has just woken up and sat up
      if (WD.clips['ss-groom'] && (want === 'groom' || (ownLife() && from === 'loaf-to-ss' && !pointerRecent(2500) && e.random() < 0.6))) {
        const at = cat.groomAt || 0; cat.groomAt = 0; cat.restore = null; return play('ss-groom', at);
      }
      if (from === 'ss-groom') return play(cat.energy < 0.4 ? 'ss-to-ssd' : 'ss-to-fs');
      return play('ss-idle', (from && WD.clips[from] && WD.clips[from].enterAt) || 0);
    }
    // just woken by himself: head up, a daydream before he sits up (woken by you or the ball: straight up)
    if (hub === 'LOAF') {
      if (!ownLife() || chaseWanted() || ball.held || !cat.dayN || !WD.clips['loaf-daydream']) return play('loaf-to-ss');
      return play('loaf-daydream');
    }
    if (hub === 'SSD') {
      if (from === 'ss-to-ssd') return play('ssd-to-nap');
      if (cat.miss || chaseWanted() || ball.held) return play('ssd-to-ss');   // pounced on nothing: no kneading the air
      return play('ssd-play', (from && WD.clips[from] && WD.clips[from].enterAt) || 0);
    }
    if (hub === 'NAP') { say('他困了，趴着打个盹'); return play('nap'); }
  }
  // from a side sit he turns back to the front first (eyes find the ball there), then goes after it with the same low turn
  // leaving a side sit. The ball on the floor ahead of him: straight down into a crouch (ss-to-crouch, then the CROUCH hub; 11-17 烁烁/碳碳:
  // he turned his back on a ball lying right in front of him to face the front first). Behind him, up on the
  // ceiling or still in your hand: he turns to the front first, hurried when the ball is what he is after.
  function ssGo() {
    const urgent = chaseWanted() || ball.held;
    if (chaseWanted() && !ball.ceil && WD.clips['ss-to-crouch'] && (ball.x - cat.x) * cat.facing > REACH * 0.5) return play('ss-to-crouch');
    cat.hurry = urgent; return play('ss-to-fs');
  }
  function ssUrgent() { if (chaseWanted() || ball.held) { ssGo(); return true; } return false; }
  // returns true when it switched clip
  function onLoop() {
    const n = cat.clip, now = e.now();
    if (n === 'stalk') return false;
    if (n === 'ssd-play') {   // sitting over the ball, tapping it
      cat.playedAt = now;
      if (chaseWanted() || ball.held) return play('ssd-to-ss'), true;
      if (cat.energy < 0.4) return play('ssd-to-nap'), true;
      const near = Math.abs(ball.x - (cat.x + SP.reach * cat.facing)) < BR * 1.5;   // only tap again if the paw can reach it
      if (cat.loops >= 2 || !near) return play('ssd-to-ss'), true;
      say('他低头拨纸团玩'); return false;
    }
    if (n === 'ss-idle') {
      if (ssUrgent()) return true;
      if (cat.energy < 0.4 && cat.loops >= 1 && !ball.held) return play('ss-to-ssd'), true;
      if (ball.held || pointerRecent()) return play('ss-to-fs'), true;
      if (cat.loops >= 1) return play('ss-to-fs'), true;   // the side sit looks up at nothing: one beat, not three
      say(cat.energy < 0.4 ? '他有点累了' : '他坐着看纸团'); return false;
    }
    if (n === 'nap') {
      cat.energy = Math.min(1, cat.energy + 0.06);
      const slept = now - cat.since;
      if (chaseWanted() && slept > 2500) return play('nap-to-ss'), true;
      const wake = WD.clips['nap-to-loaf'] ? 'nap-to-loaf' : 'nap-to-ss';
      if (pointerRecent(1200) && slept > 4000) { cat.dayN = 0; return play(wake), true; }
      if (cat.energy >= 1 && slept > 14000) { cat.dayN = 2 + (e.random() < 0.5 ? 1 : 0); return play(wake), true; }
      say('他在睡觉，动动鼠标叫醒他'); return false;
    }
    if (n === 'loaf-daydream') {
      if (chaseWanted() || ball.held || pointerRecent(1500) || cat.loops >= cat.dayN) return play('loaf-to-ss'), true;
      return false;
    }
    if (n === 'fs-idle') {
      const bored = now - Math.max(cat.since, ptr.at);
      if (ownLife() && bored > 16000 && cat.energy > 0.6 && Math.abs(ball.x - cat.x) > REACH) { ball.fresh = true; say('他自己去找纸团玩了'); }
      if (bored > 8000 && cat.energy < 0.4 && !ball.fresh && canMove()) return play('fs-to-ss'), true;
      if (chaseWanted()) { arrive('FS'); return true; }
      // the activity a reopen put off for the beret: picked up where it was saved (scene.mjs), however long that took
      if (cat.restore && canMove() && !ball.held && !ball.fresh && !pointerRecent(3000) && e.resumeRestored()) return true;
      // nobody is playing with him (11-17 一个人在家): something of his own, never the same one twice running; after
      // two of them he goes and gets the ball himself
      const rs = cat.resume && now - cat.resume.at < IN_SESSION_RESUME_MS ? cat.resume : null;
      if (rs && ownLife() && bored > 2500 && canMove() && !ball.held && !ball.fresh && !pointerRecent(3000)) {
        if (rs.kind === 'groom') { cat.resume = null; cat.want = 'groom'; cat.groomAt = 0; play('fs-to-ss'); say('他接着把毛理完'); return true; }
        const side = e.paperSide();
        if (rs.kind === 'draft' && side) { cat.resume = null; cat.facing = side; play('fs-draft', rs.i); say('他接着研究刚才的草稿'); return true; }
      }
      if (ownLife() && bored > 6000 && canMove() && !ball.held && !ball.fresh && !pointerRecent(5000)) {
        if (cat.soloN >= 2 && cat.energy > 0.6 && Math.abs(ball.x - cat.x) > REACH) { cat.soloN = 0; ball.fresh = true; say('他自己去找纸团玩了'); arrive('FS'); return true; }
        const side = e.paperSide(), opts = [];
        if (side && WD.clips['fs-draft']) opts.push('draft');
        if (WD.clips['ss-groom']) opts.push('groom');
        if (cat.energy > 0.5) opts.push('hide');
        let pick = opts.filter(o => o !== cat.lastSolo);
        if (opts.includes('hide') && !cat.lastHide) pick = ['hide'];   // the first thing he does alone is hide (new, 11-18)
        if (!pick.length && e.random() < 0.6) pick = []; else if (!pick.length) pick = opts;   // only the same thing again: mostly he just sits a while longer
        if (pick.length) {
          const o = pick[Math.floor(e.random() * pick.length)]; cat.lastSolo = o; cat.soloN = (cat.soloN || 0) + 1;
          if (o === 'draft') { cat.facing = side; play('fs-draft'); return true; }
          if (o === 'hide') { e.startHide(); return true; }
          cat.want = 'groom'; play('fs-to-ss'); say('他转过身去理理毛'); return true;
        }
      }
      cat.pauseUntil = now + 1500 + e.random() * 3500; say('他在发呆'); return false;
    }
    return false;
  }

  Object.assign(e, { arrive, ssGo, ssUrgent, onLoop });
}

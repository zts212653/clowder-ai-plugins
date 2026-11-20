// F336 Phase C: drawing the cat, the box, his draft and the paper ball (ported from the card engine). The body window is
// transparent: no room, only what is his. renderKey() names everything a frame would show, so the page repaints only
// when it changes (the frame, his place, the ball, the paper, hearts, the box sink, the nap breath).
import { BOX, REFX, PW } from './constants.mjs';

export function installDraw(e) {
  const { WD, K, cat, ball, ptr, paper, hearts, view: v } = e;
  const { BR, GROUND, PET } = K;
  const clip = () => e.clip();

  function drawnFrame() {
    const c = clip(), fr = (cat.clip === 'stalk' && cat.wall && WD.clips['stalk-up']) ? WD.clips['stalk-up'].frames : c.frames;
    return fr[Math.min(fr.length - 1, Math.max(0, cat.i))];
  }
  const breath = now => (cat.clip === 'nap' ? 1 + 0.014 * Math.sin(now / 3400 * Math.PI * 2) : 0);
  const nuzzle = now => (cat.clip === 'fs-pet' && cat.i >= PET.petLoop[0]
    ? (1.1 + 1.3 * Math.sin(now / 1050 * Math.PI * 2)) * Math.PI / 180 * (cat.pet ? 1 : 0.5) : 0);
  const sniffTurn = () => (cat.clip === 'fs-sniff'   // nose toward your hand (烁烁 11-18)
    ? Math.sign(ptr.x - e.eyeScreen()[0]) * 2.6 * Math.min(1, Math.max(0, cat.i) / 8) * Math.PI / 180 : 0);

  function drawFrame(ctx, f, x, breathing, facing = e.drawFacing()) {
    const [ax, ay, w, h, ox, oy, aid] = WD.frames[f], s = WD.scale, k = v.k;
    const atlas = e.atlases[aid || 0]; if (!atlas) return;
    const cw = w / s * k, ch = h / s * k;
    const yf = x === cat.x && clip().yfix ? (clip().yfix[cat.i] || 0) : 0;
    let sy = v.floorY + (oy - GROUND + yf) * k - (x === cat.x ? cat.y - (cat.sink || 0) : 0) * k, chh = ch;
    if (breathing) { chh = ch * breathing; sy = v.floorY - (GROUND - oy) * k * breathing; }
    if (facing > 0) { ctx.drawImage(atlas, ax, ay, w, h, (x + ox - REFX) * k, sy, cw, chh); }
    else {
      const sx = (x - (ox + w / s - REFX)) * k;
      ctx.save(); ctx.translate(sx + cw, sy); ctx.scale(-1, 1); ctx.drawImage(atlas, ax, ay, w, h, 0, 0, cw, chh); ctx.restore();
    }
  }
  function drawBall(ctx) {
    const [ax, ay, w, h, , , aid] = WD.frames[WD.ball], s = WD.scale, k = v.k, floorY = v.floorY;
    const atlas = e.atlases[aid || 0]; if (!atlas) return;
    const d = WD.ballD * k, bx = ball.x * k, by = floorY - ball.h * k;
    const sh = Math.max(0.25, 1 - (ball.h - BR) / 600);
    ctx.fillStyle = `rgba(120,80,50,${0.16 * sh})`; ctx.beginPath(); ctx.ellipse(bx, floorY, d * 0.45 * sh, d * 0.12 * sh, 0, 0, Math.PI * 2); ctx.fill();
    const q = ball.sq, sx = 1 + 0.24 * q, sy = 1 - 0.32 * q;   // squashed when pressed: wider, flatter, still sitting on the floor
    ctx.save(); ctx.translate(bx, by + (1 - sy) * d / 2); ctx.scale(sx, sy); ctx.rotate(ball.spin);
    ctx.drawImage(atlas, ax, ay, w, h, -w / s * k / 2, -h / s * k / 2, w / s * k, h / s * k); ctx.restore();
  }
  // the sheet lying on the floor, seen from a little above: far edge 12 px up the floor, near edge 14 px in front of it
  function drawPaper(ctx) {
    if (!Number.isFinite(paper.x)) return;
    const k = v.k, w = PW * k, f = 12 * k, n = 14 * k;
    ctx.save(); ctx.translate(paper.x * k, v.floorY); ctx.rotate(paper.tilt);
    ctx.fillStyle = 'rgba(120,80,50,0.16)'; ctx.beginPath(); ctx.ellipse(w * 0.02, n * 0.7, w * 0.54, n * 0.7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fbf6ec'; ctx.strokeStyle = 'rgba(150,118,88,0.6)'; ctx.lineWidth = Math.max(1, 1.2 * k);
    ctx.beginPath(); ctx.moveTo(-w * 0.43, -f); ctx.lineTo(w * 0.45, -f); ctx.lineTo(w * 0.5, n); ctx.lineTo(-w * 0.5, n * 0.92); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(84,92,120,0.5)'; ctx.lineWidth = Math.max(0.8, 1.1 * k); ctx.beginPath();   // a little sketch: a head, ears, two lines of notes
    ctx.ellipse(-w * 0.2, n * 0.2, w * 0.1, n * 0.42, 0, 0, Math.PI * 2); ctx.moveTo(-w * 0.28, -n * 0.08); ctx.lineTo(-w * 0.25, -n * 0.5); ctx.lineTo(-w * 0.2, -n * 0.2);
    ctx.moveTo(-w * 0.12, -n * 0.08); ctx.lineTo(-w * 0.14, -n * 0.5); ctx.lineTo(-w * 0.18, -n * 0.2);
    ctx.moveTo(w * 0.02, -f * 0.35); ctx.lineTo(w * 0.36, -f * 0.35); ctx.moveTo(w * 0.04, n * 0.35); ctx.lineTo(w * 0.32, n * 0.35); ctx.stroke();
    // the near right corner curls up a little: a sheet of paper, not a mark on the floor
    ctx.fillStyle = '#efe6d6'; ctx.strokeStyle = 'rgba(150,118,88,0.6)'; ctx.lineWidth = Math.max(1, 1.2 * k); ctx.beginPath();
    ctx.moveTo(w * 0.5, n); ctx.lineTo(w * 0.35, n); ctx.quadraticCurveTo(w * 0.43, n * 0.55, w * 0.49, n * 0.05); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
  }
  function drawHearts(ctx, now) {
    const k = v.k;
    for (let i = hearts.length - 1; i >= 0; i--) {
      const q = hearts[i], u = (now - q.t) / 1500;
      if (u >= 1) { hearts.splice(i, 1); continue; }
      const x = (q.x + q.dx * u) * k, y = v.floorY - (q.h + 95 * u) * k, z = (8 + 5 * Math.min(1, u * 5)) * k;
      ctx.globalAlpha = 1 - u * u; ctx.fillStyle = '#ef7d8e'; ctx.beginPath();
      ctx.moveTo(x, y + z * 0.4); ctx.bezierCurveTo(x, y, x - z, y, x - z, y + z * 0.4); ctx.bezierCurveTo(x - z, y + z * 0.85, x, y + z * 1.15, x, y + z * 1.45);
      ctx.bezierCurveTo(x, y + z * 1.15, x + z, y + z * 0.85, x + z, y + z * 0.4); ctx.bezierCurveTo(x + z, y, x, y, x, y + z * 0.4); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  function draw(ctx, now) {
    const k = v.k, floorY = v.floorY;
    ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0); ctx.clearRect(0, 0, v.W, v.H);
    if (!e.atlases[0]) return;
    const f = drawnFrame();
    const inBox = !!(cat.hide && cat.hide.inBox); e.drawBox(ctx, false);
    // in the box: between its back and its front wall; while he is down in it, nothing of him outside the box
    // above the rim is open air: nothing is cut at the box's sides there (碳碳 11-18: a paw out over the side wall was cut off)
    if (inBox) {
      const [bl, br] = e.boxInner(), ry = e.rimY(), fl = floorY - BOX.back * k;
      ctx.save(); ctx.beginPath(); ctx.rect(-1e4, -1e4, 2e4, ry + 1e4); ctx.rect(bl * k, ry, (br - bl) * k, fl - ry); ctx.clip(); drawFrame(ctx, f, cat.x, 0); ctx.restore();
    }
    e.drawBox(ctx, true);
    const up = Math.max(0.15, 1 - cat.y / 500);
    if (!inBox) { ctx.fillStyle = `rgba(120,80,50,${0.15 * up})`; ctx.beginPath(); ctx.ellipse(cat.x * k, floorY, 150 * k * up, 16 * k * up, 0, 0, Math.PI * 2); ctx.fill(); }
    drawPaper(ctx);
    const inAir = ball.held || ball.h > BR + 30;
    if (!inAir) drawBall(ctx);
    if (!inBox) {
      const nuz = nuzzle(now), sn = sniffTurn();
      if (sn && !nuz) { ctx.save(); ctx.translate(cat.x * k, floorY); ctx.rotate(sn); ctx.translate(-cat.x * k, -floorY); }
      if (nuz) { ctx.save(); ctx.translate(cat.x * k, floorY); ctx.rotate(nuz); ctx.translate(-cat.x * k, -floorY); }   // pivot at his seat on the floor
      drawFrame(ctx, f, cat.x, breath(now)); ctx.globalAlpha = 1;
      if (nuz || sn) ctx.restore();
    }
    drawHearts(ctx, now);
    if (inAir) drawBall(ctx);
  }
  /** Everything the next draw would show, quantised to a quarter pixel: equal keys draw the same picture. */
  function renderKey(now) {
    if (!e.atlases[0]) return `empty:${v.W}x${v.H}@${v.dpr}`;
    const k = v.k, q = value => Math.round(value * k * 4), f = drawnFrame();
    const h = WD.frames[f][3], s = WD.scale;
    const yf = clip().yfix ? (clip().yfix[cat.i] || 0) : 0;
    return [
      v.W, v.H, v.dpr, e.atlases.map(Boolean).join(''), f, e.drawFacing(), q(cat.x), q(cat.y), q(cat.sink || 0), yf,
      cat.hide && cat.hide.inBox ? 1 : 0, Math.round(h / s * k * breath(now) * v.dpr * 2),
      Math.round(nuzzle(now) * 4000), Math.round(sniffTurn() * 4000),
      q(ball.x), q(ball.h), Math.round(ball.sq * 100), Math.round(ball.spin * 40), ball.held ? 1 : 0,
      q(paper.x), Math.round(paper.tilt * 1000), hearts.length ? `h${hearts.length}:${Math.round(now / 16)}` : '',
    ].join('|');
  }

  Object.assign(e, { draw, renderKey, drawnFrame });
}

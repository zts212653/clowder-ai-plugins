import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

// The Host's static-surface policy (cat-cafe static-surface-server.ts), so the built page proves it
// needs no inline script, no network and no workers, and that its atlases load as package images.
const HOST_POLICY = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "font-src 'self' data:", "connect-src 'none'", "worker-src 'none'", "child-src 'none'", "object-src 'none'",
  "base-uri 'none'", "form-action 'none'", "media-src 'self' blob:", "frame-ancestors 'none'",
].join('; ');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webp': 'image/webp',
};
const root = resolve(fileURLToPath(new URL('../renderer/', import.meta.url)));
const AREA = { width: 1440, height: 860 };

let browser;
let server;
let origin;

before(async () => {
  server = createServer(async (req, res) => {
    const file = resolve(root, `.${decodeURIComponent(new URL(req.url, 'http://localhost').pathname)}`);
    if (!file.startsWith(root + sep) || !MIME[extname(file)]) { res.writeHead(404).end(); return; }
    try {
      const content = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)], 'Content-Security-Policy': HOST_POLICY, 'Cache-Control': 'no-store' });
      res.end(content);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await new Promise(done => server.close(done));
});

/** The Host stand-in lives in the page like the preload: it records commands and pushes events. */
function installFakeHost(read) {
  window.__sent = [];
  window.__draws = 0;
  window.__frames = 0;
  window.__violations = [];
  window.__clips = [];
  const listeners = new Set();
  const clear = CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect = function (...args) { window.__draws++; return clear.apply(this, args); };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = callback => raf(time => { window.__frames++; callback(time); });
  document.addEventListener('securitypolicyviolation', event => window.__violations.push(event.violatedDirective));
  window.clowderCompanion = {
    async request(command) {
      window.__sent.push(JSON.parse(JSON.stringify(command)));
      return command.kind === 'scene.get' ? read : { kind: 'ok' };
    },
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
  };
  window.__emit = event => { for (const callback of listeners) callback(event); };
  // the clip sequence, as the card's eval harness read it from window.__xxCat
  setInterval(() => {
    const clip = window.__xxCat?.().clip;
    if (clip && window.__clips.at(-1) !== clip) window.__clips.push(clip);
  }, 15);
}

async function openBody(read) {
  const page = await browser.newPage({ viewport: AREA });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(installFakeHost, read);
  await page.goto(`${origin}/body.html`);
  // drawn and clickable once the front-sit atlas is in: the cat and his paper ball
  await page.waitForFunction(() => window.__xxCat?.().full && window.__sent.some(command => command.kind === 'body.hit' && command.rects.length === 2));
  const sent = kind => page.evaluate(name => window.__sent.filter(command => command.kind === name), kind);
  const cat = () => page.evaluate(() => window.__xxCat());
  const region = async () => {
    const [body, ball] = (await sent('body.hit')).at(-1).rects;
    return { body, ball, center: rect => [rect.x + rect.width / 2, rect.y + rect.height / 2] };
  };
  return { page, errors, sent, cat, region };
}

test('the built body page draws him on the floor of the work area, repaints only on change and keeps the lease', async () => {
  const { page, errors, sent, cat, region } = await openBody({ kind: 'scene', status: 'not_found' });
  try {
    assert.equal((await page.evaluate(() => window.__sent[0])).kind, 'scene.get', 'the scene is read before anything is reported');
    const { body, ball } = await region();
    const floor = AREA.height - body.y - body.height;
    assert.ok(floor >= 0 && floor <= 12, `he sits on the bottom edge of the work area (${floor} px above it)`);
    assert.ok(body.height >= 120 && body.height <= 175, `a standing height of about 150 px (${body.height})`);
    assert.ok(ball.y + ball.height <= AREA.height && ball.y + ball.height >= AREA.height - 20, 'the paper ball lies on the same floor');
    assert.deepEqual((await sent('body.anchor')).at(-1).rect, body, 'the panel anchors to his visible body');
    const pixels = await page.evaluate(({ body: r }) => {
      const context = document.getElementById('world').getContext('2d');
      const alpha = (x, y, w, h) => { let sum = 0; const data = context.getImageData(x, y, w, h).data; for (let i = 3; i < data.length; i += 4) sum += data[i]; return sum; };
      return { cat: alpha(r.x, r.y, r.width, r.height), sky: alpha(0, 0, 1440, 600) };
    }, { body });
    assert.ok(pixels.cat > 0, 'he is drawn');
    assert.equal(pixels.sky, 0, 'no room: everything above the floor is see-through');
    await page.waitForFunction(() => window.__sent.some(command => command.kind === 'scene.report'));
    assert.deepEqual((await sent('scene.report'))[0].dirty, ['pose', 'ball', 'paper', 'hat', 'activity', 'lastSolo']);

    const before = await page.evaluate(() => ({ draws: window.__draws, frames: window.__frames, renew: window.__sent.filter(c => c.kind === 'body.hit.renew').length }));
    await page.waitForTimeout(2000);
    const later = await page.evaluate(() => ({ draws: window.__draws, frames: window.__frames, renew: window.__sent.filter(c => c.kind === 'body.hit.renew').length }));
    assert.ok(later.renew - before.renew >= 3, 'the lease renews every 500 ms');
    assert.ok(later.frames - before.frames > 60, 'his clock runs');
    assert.ok(later.draws - before.draws <= (later.frames - before.frames) / 2, `repaints only when the picture changes (${later.draws - before.draws} of ${later.frames - before.frames} frames)`);

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const hidden = await page.evaluate(() => ({ draws: window.__draws, frames: window.__frames, cat: JSON.stringify(window.__xxCat()) }));
    await page.waitForTimeout(600);
    assert.deepEqual(await page.evaluate(() => ({ draws: window.__draws, frames: window.__frames, cat: JSON.stringify(window.__xxCat()) })), hidden,
      'hidden: his clock stops and nothing is drawn');

    await page.setViewportSize({ width: 1000, height: 600 });
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      window.__emit({ kind: 'body-area', width: 1000, height: 600 });
    });
    await page.waitForFunction(() => window.__sent.filter(c => c.kind === 'body.hit').at(-1).rects.every(r => r.y + r.height <= 600));
    const moved = (await region()).body;
    assert.ok(moved.x >= 0 && moved.x + moved.width <= 1000 && 600 - moved.y - moved.height <= 12, `the new floor: ${JSON.stringify(moved)}`);
    assert.equal((await cat()).room.join('x'), '1000x600');

    for (const command of await page.evaluate(() => window.__sent)) assert.match(command.kind, /^(?:body|scene)\./u);
    assert.deepEqual(await page.evaluate(() => window.__violations), [], 'nothing breaks the static-surface policy');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('a press on the ball and a throw sends him after it; a press on empty space is the desktop\'s; right-click opens the menu', async () => {
  const { page, errors, sent, cat, region } = await openBody({ kind: 'scene', status: 'not_found' });
  try {
    const { body, ball, center } = await region();
    const [ex, ey] = [body.x - 260, 300];
    await page.mouse.move(ex, ey);
    await page.mouse.down();
    await page.mouse.move(ex - 120, ey + 40, { steps: 4 });
    await page.mouse.up();
    let state = await cat();
    assert.equal(state.ball.held, false, 'a press on empty space does not take the ball');
    assert.equal(state.ball.fresh, false);

    await page.mouse.click(ex, ey, { button: 'right' });
    await page.mouse.click(...center(body), { button: 'right' });
    await page.waitForFunction(() => window.__sent.some(command => command.kind === 'body.menu'));
    assert.deepEqual(await sent('body.menu'), [{ kind: 'body.menu' }], 'only the right-click on him opens the menu');

    const [bx, by] = center(ball);
    await page.evaluate(() => { window.__clips = []; });
    await page.mouse.move(bx, by);
    await page.mouse.down();
    assert.equal((await cat()).ball.held, true, 'a press on the ball picks it up');
    await page.mouse.move(bx - 40, by - 60, { steps: 2 });
    await page.mouse.move(bx - 160, by - 140, { steps: 3 });
    await page.mouse.up();
    state = await cat();
    assert.equal(state.ball.held, false);
    assert.equal(state.ball.fresh, true, 'thrown');
    await page.waitForFunction(() => window.__clips.includes('pounce'), null, { timeout: 20000 });
    const clips = await page.evaluate(() => window.__clips);
    const getUp = clips.findIndex(clip => /^fs-to-(?:st|crouch)/u.test(clip));
    assert.ok(getUp >= 0 && getUp < clips.indexOf('pounce'), `he gets up and goes for it: ${clips.join(' > ')}`);
    await page.waitForFunction(() => window.__sent.some(c => c.kind === 'scene.report' && c.dirty.includes('ball')), null, { timeout: 20000 });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('reopened, he is as he was: the ball where it lay and the beret still askew; an unreadable archive is never written', async () => {
  const first = await openBody({ kind: 'scene', status: 'not_found' });
  let snapshot;
  try {
    const { body } = await first.region();
    await first.page.mouse.move(body.x + body.width / 2, body.y + body.height * 0.12);
    await first.page.mouse.down();
    await first.page.waitForFunction(() => window.__xxCat().askew, null, { timeout: 5000 });
    await first.page.mouse.up();
    await first.page.waitForFunction(() => window.__sent.some(c => c.kind === 'scene.report' && c.snapshot.hat.askew));
    snapshot = (await first.sent('scene.report')).findLast(report => report.snapshot.hat.askew).snapshot;
    assert.deepEqual(first.errors, []);
  } finally {
    await first.page.close();   // quit with the beret askew
  }

  const saved = { ...snapshot, ball: { x: 0.25, h: 0.02, ceil: false } };
  const reopened = await openBody({ kind: 'scene', status: 'found', revision: 3, snapshot: saved });
  try {
    const state = await reopened.cat();
    assert.equal(state.askew, true, 'the beret is still askew');
    assert.equal(state.clip, 'fs-hat');
    assert.ok(Math.abs(state.ball.x - 0.25 * state.worldW) <= 1, `the ball lies where it was (${state.ball.x} of ${state.worldW})`);
    await reopened.page.waitForTimeout(300);
    assert.equal((await reopened.sent('scene.report')).length, 0, 'a found scene is not written back by itself');
    assert.deepEqual(reopened.errors, []);
  } finally {
    await reopened.page.close();
  }

  const unsaved = await openBody({ kind: 'scene', status: 'error', reason: 'corrupt' });
  try {
    const { body, ball, center } = await unsaved.region();
    await unsaved.page.mouse.move(body.x + body.width / 2, body.y + body.height * 0.12);
    await unsaved.page.mouse.down();
    await unsaved.page.waitForFunction(() => window.__xxCat().askew, null, { timeout: 5000 });
    await unsaved.page.mouse.up();
    await unsaved.page.mouse.move(...center(ball));
    await unsaved.page.mouse.down();
    await unsaved.page.mouse.move(center(ball)[0] - 100, center(ball)[1] - 80, { steps: 3 });
    await unsaved.page.mouse.up();
    await unsaved.page.evaluate(() => window.__emit({ kind: 'scene-flush' }));
    await unsaved.page.waitForTimeout(1500);
    assert.equal((await unsaved.sent('scene.report')).length, 0, 'an unsaved body plays on but never reports');
    assert.deepEqual(unsaved.errors, []);
  } finally {
    await unsaved.page.close();
  }
});

test('reopened with the beret askew over a draft at frame 7, a ball thrown far away puts the draft off; every report still names it', async () => {
  const snapshot = {
    schemaVersion: 1, pose: { hub: 'FS', facing: 'right', x: 0.3 }, ball: { x: 0.36, h: 0, ceil: false }, paper: { x: 0.3 },
    hat: { askew: true }, activity: { kind: 'draft', frame: 7 }, lastSolo: null,
  };
  const { page, errors, sent, cat, region } = await openBody({ kind: 'scene', status: 'found', revision: 4, snapshot });
  try {
    assert.equal((await cat()).activity, 'draft:7', 'waiting behind the beret');
    const { ball, center } = await region();
    const [bx, by] = center(ball);
    await page.evaluate(() => { window.__clips = []; });
    await page.mouse.move(bx, by);
    await page.mouse.down();
    await page.mouse.move(bx + 120, by - 80, { steps: 2 });
    await page.mouse.move(bx + 420, by - 220, { steps: 3 });
    await page.mouse.up();
    await page.waitForFunction(() => window.__clips.includes('pounce'), null, { timeout: 30000 });
    // he has the ball, far from the sheet, and sits up again
    await page.waitForFunction(() => {
      const c = window.__xxCat();
      return !c.ball.fresh && !c.askew && /^fs-(?:idle|look)/u.test(c.clip) && Math.abs(c.x - c.paper) > 400;
    }, null, { timeout: 30000 });
    // alone, he sets off for the box from the same idle loop that would go back to a draft within reach
    await page.waitForFunction(() => window.__xxCat().hide, null, { timeout: 30000 });
    await page.evaluate(() => window.__emit({ kind: 'scene-flush' }));
    await page.waitForFunction(() => window.__sent.filter(c => c.kind === 'scene.report').length > 0);
    const state = await cat();
    assert.equal(state.activity, 'draft:7', `put off, not finished: ${state.clip} at ${state.x}, the sheet at ${state.paper}`);
    assert.ok(!(await page.evaluate(() => window.__clips)).some(clip => /^fs-draft/u.test(clip)), 'no draft frame played out of reach');
    const reports = await sent('scene.report');
    assert.ok(reports.length > 0);
    for (const report of reports) assert.deepEqual(report.snapshot.activity, { kind: 'draft', frame: 7 }, 'the next reopen still knows the draft');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('body-area sizes him: the Host\'s standHeight grows and shrinks the drawn cat and his click region; an area without one keeps his size', async () => {
  const { page, errors, cat, region } = await openBody({ kind: 'scene', status: 'not_found' });
  const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  try {
    assert.equal((await cat()).stand, 150, 'before the Host names a height he stands at the default');
    const small = (await region()).body;
    await page.evaluate(() => window.__emit({ kind: 'body-area', width: 1440, height: 860, standHeight: 260 }));
    await settle();
    assert.equal((await cat()).stand, 260);
    const large = (await region()).body;
    const ratio = large.height / small.height;
    assert.ok(ratio > 1.6 && ratio < 1.87, `his sprite grows with his height (${small.height} → ${large.height}, ×${ratio.toFixed(2)})`);
    assert.ok(AREA.height - large.y - large.height <= 24, 'still standing on the floor');

    await page.setViewportSize({ width: 1200, height: 800 });
    await page.evaluate(() => window.__emit({ kind: 'body-area', width: 1200, height: 800 }));
    await settle();
    const kept = await cat();
    assert.deepEqual([kept.stand, kept.room.join('x')], [260, '1200x800'], 'a new work area without a height keeps the one he has');
    const moved = (await region()).body;
    assert.ok(moved.x >= 0 && moved.x + moved.width <= 1200 && moved.y + moved.height <= 800, JSON.stringify(moved));

    await page.evaluate(() => window.__emit({ kind: 'body-area', width: 1200, height: 800, standHeight: 90 }));
    await settle();
    assert.equal((await cat()).stand, 90, 'the smallest size setting makes him small');
    assert.ok((await region()).body.height < small.height, 'and his click region with him');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('autonomous activity off (body-preferences): alone he never sets off by himself, a thrown ball is still chased, and back on his own life resumes', async () => {
  const off = await openBody({ kind: 'scene', status: 'not_found' });
  const back = await openBody({ kind: 'scene', status: 'not_found' });
  const OWN = /^(?:fs-to-st|fs-to-crouch|stalk|pounce|fs-draft|fs-to-ss|ss-groom)/u;
  try {
    for (const body of [off, back]) {
      await body.page.evaluate(() => {
        window.__emit({ kind: 'body-preferences', behaviorEnabled: false });
        window.__clips = [];
        window.__hides = [];
        window.__fresh = false;
        const x = window.__xxCat().x;
        window.__xs = [x, x];
        setInterval(() => {
          const cat = window.__xxCat();
          if (cat.hide && window.__hides.at(-1) !== cat.hide) window.__hides.push(cat.hide);
          if (cat.ball.fresh) window.__fresh = true;
          window.__xs = [Math.min(window.__xs[0], cat.x), Math.max(window.__xs[1], cat.x)];
        }, 15);
      });
    }
    // with it on, a cat nobody plays with sets off for the box after about 6-12 s and fetches the ball after 16 s
    await off.page.waitForTimeout(18000);
    for (const [name, body] of [['off', off], ['back', back]]) {
      const seen = await body.page.evaluate(() => ({ clips: window.__clips, hides: window.__hides, fresh: window.__fresh, xs: window.__xs, behavior: window.__xxCat().behavior }));
      assert.deepEqual(seen.hides, [], `${name}: no walk to the box`);
      assert.equal(seen.fresh, false, `${name}: no fetching the ball on his own`);
      assert.ok(seen.xs[1] - seen.xs[0] <= 2, `${name}: he sits where he is (${seen.xs})`);
      assert.deepEqual(seen.clips.filter(clip => OWN.test(clip)), [], `${name}: ${seen.clips.join(' > ')}`);
      assert.equal(seen.behavior, false, name);
    }

    const chase = (async () => {
      const { ball, center } = await off.region();
      const [bx, by] = center(ball);
      await off.page.evaluate(() => { window.__clips = []; });
      await off.page.mouse.move(bx, by);
      await off.page.mouse.down();
      await off.page.mouse.move(bx - 40, by - 60, { steps: 2 });
      await off.page.mouse.move(bx - 160, by - 140, { steps: 3 });
      await off.page.mouse.up();
      await off.page.waitForFunction(() => window.__clips.includes('pounce'), null, { timeout: 20000 });
    })();
    const resume = (async () => {
      await back.page.evaluate(() => { window.__clips = []; window.__emit({ kind: 'body-preferences', behaviorEnabled: true }); });
      // bored by now: the box, the ball on his own, a draft or a groom, whichever comes first
      await back.page.waitForFunction(() => window.__hides.length > 0 || window.__fresh
        || window.__clips.some(clip => /^(?:fs-draft|fs-to-ss|ss-groom)/u.test(clip)), null, { timeout: 20000 });
      return back.page.evaluate(() => ({ behavior: window.__xxCat().behavior, hides: window.__hides, fresh: window.__fresh, clips: window.__clips }));
    })();
    const [, resumed] = await Promise.all([chase, resume]);
    assert.equal(resumed.behavior, true);
    const clips = await off.page.evaluate(() => window.__clips);
    const getUp = clips.findIndex(clip => /^fs-to-(?:st|crouch)/u.test(clip));
    assert.ok(getUp >= 0 && getUp < clips.indexOf('pounce'), `off, he still gets up and goes for a thrown ball: ${clips.join(' > ')}`);
    for (const body of [off, back]) {
      for (const command of await body.page.evaluate(() => window.__sent)) assert.match(command.kind, /^(?:body|scene)\./u);
      assert.deepEqual(body.errors, []);
    }
  } finally {
    await off.page.close();
    await back.page.close();
  }
});

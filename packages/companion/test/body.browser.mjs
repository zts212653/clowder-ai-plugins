import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

// The Host's static-surface policy (cat-cafe static-surface-server.ts), so the built page proves it
// needs no inline script, no network and no workers.
const HOST_POLICY = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "font-src 'self' data:", "connect-src 'none'", "worker-src 'none'", "child-src 'none'", "object-src 'none'",
  "base-uri 'none'", "form-action 'none'", "media-src 'self' blob:", "frame-ancestors 'none'",
].join('; ');
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const root = resolve(fileURLToPath(new URL('../renderer/', import.meta.url)));

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
  window.__violations = [];
  const listeners = new Set();
  const clear = CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect = function (...args) { window.__draws++; return clear.apply(this, args); };
  document.addEventListener('securitypolicyviolation', event => window.__violations.push(event.violatedDirective));
  window.clowderCompanion = {
    async request(command) {
      window.__sent.push(JSON.parse(JSON.stringify(command)));
      return command.kind === 'scene.get' ? read : { kind: 'ok' };
    },
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
  };
  window.__emit = event => { for (const callback of listeners) callback(event); };
}

async function openBody(read, viewport = { width: 1280, height: 800 }) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(installFakeHost, read);
  await page.goto(`${origin}/body.html`);
  await page.waitForFunction(() => window.__sent.some(command => command.kind === 'body.hit'));
  const sent = kind => page.evaluate(name => window.__sent.filter(command => command.kind === name), kind);
  return { page, errors, sent };
}

test('the built body page reads its scene, then claims only the cat on the floor and keeps the lease', async () => {
  const { page, errors, sent } = await openBody({ kind: 'scene', status: 'not_found' });
  try {
    assert.equal((await page.evaluate(() => window.__sent[0])).kind, 'scene.get', 'the scene is read before anything is reported');
    const [hit] = await sent('body.hit');
    assert.equal(hit.rects.length, 1);
    const cat = hit.rects[0];
    assert.equal(cat.y + cat.height, 800, 'he stands on the bottom edge of the work area');
    assert.ok(cat.x >= 0 && cat.x + cat.width <= 1280 && cat.width * cat.height < 0.15 * 1280 * 800, JSON.stringify(cat));
    assert.deepEqual((await sent('body.anchor')).at(-1).rect, cat, 'the panel anchors to the visible body');
    await page.waitForFunction(() => window.__sent.some(command => command.kind === 'scene.report'));
    assert.deepEqual((await sent('scene.report'))[0].dirty, ['pose', 'ball', 'paper', 'hat', 'activity', 'lastSolo'],
      'only a not_found read starts and saves a new scene');

    const drawsBefore = await page.evaluate(() => window.__draws);
    const renewBefore = (await sent('body.hit.renew')).length;
    await page.waitForTimeout(1300);
    assert.ok((await sent('body.hit.renew')).length - renewBefore >= 2, 'a still cat renews its lease every 500 ms');
    assert.equal(await page.evaluate(() => window.__draws), drawsBefore, 'renewing does not repaint, and nothing repaints idly');

    await page.mouse.click(cat.x + cat.width / 2, cat.y + cat.height * 0.75, { button: 'right' });
    await page.waitForFunction(() => window.__sent.some(command => command.kind === 'body.menu'));
    assert.deepEqual((await sent('body.menu'))[0], { kind: 'body.menu' });

    await page.mouse.click(cat.x + cat.width / 2, cat.y + 8);
    await page.waitForFunction(() => window.__sent.filter(command => command.kind === 'scene.report').length >= 2);
    const rubbed = (await sent('scene.report'))[1];
    assert.deepEqual(rubbed.dirty, ['hat']);
    assert.deepEqual(rubbed.snapshot.hat, { askew: true });
    assert.equal(await page.evaluate(() => window.__draws), drawsBefore + 1, 'one change, one repaint');

    await page.evaluate(() => window.__emit({ kind: 'scene-flush' }));
    await page.waitForFunction(() => window.__sent.filter(command => command.kind === 'scene.report').length >= 3);
    assert.deepEqual((await sent('scene.report'))[2].dirty, [], 'a flush is answered even when nothing changed');

    await page.setViewportSize({ width: 1000, height: 600 });
    await page.evaluate(() => window.__emit({ kind: 'body-area', width: 1000, height: 600 }));
    await page.waitForFunction(() => window.__sent.filter(command => command.kind === 'body.hit').length >= 2);
    const moved = (await sent('body.hit')).at(-1).rects[0];
    assert.equal(moved.y + moved.height, 600, 'a new work area re-maps the floor');
    assert.ok(moved.x + moved.width <= 1000);
    assert.equal(await page.evaluate(() => document.getElementById('world').style.width), '1000px');

    for (const command of await page.evaluate(() => window.__sent)) assert.match(command.kind, /^(?:body|scene)\./u);
    assert.deepEqual(await page.evaluate(() => window.__violations), [], 'nothing breaks the static-surface policy');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test('a saved scene comes back as it was, and an unreadable archive is never written', async () => {
  const saved = { schemaVersion: 1, pose: { name: 'LOAF', facing: 'right' }, hat: { askew: true }, paper: { x: 0.4 } };
  const restored = await openBody({ kind: 'scene', status: 'found', revision: 5, snapshot: saved });
  try {
    const cat = (await restored.sent('body.hit'))[0].rects[0];
    await restored.page.waitForTimeout(200);
    assert.equal((await restored.sent('scene.report')).length, 0, 'a found scene is not written back by itself');
    await restored.page.mouse.click(cat.x + cat.width / 2, cat.y + 8);
    await restored.page.waitForFunction(() => window.__sent.some(command => command.kind === 'scene.report'));
    const [report] = await restored.sent('scene.report');
    assert.deepEqual(report.snapshot.hat, { askew: false }, 'the hat was still askew from before');
    assert.deepEqual(report.snapshot.pose, { name: 'LOAF', facing: 'right' });
    assert.deepEqual(report.dirty, ['ball', 'hat', 'activity', 'lastSolo'],
      'the rubbed hat plus the fields this archive lacked; restored pose and paper are untouched');
    assert.deepEqual(restored.errors, []);
  } finally {
    await restored.page.close();
  }

  const unsaved = await openBody({ kind: 'scene', status: 'error', reason: 'corrupt' });
  try {
    const cat = (await unsaved.sent('body.hit'))[0].rects[0];
    await unsaved.page.mouse.click(cat.x + cat.width / 2, cat.y + 8);
    await unsaved.page.evaluate(() => window.__emit({ kind: 'scene-flush' }));
    await unsaved.page.waitForTimeout(300);
    assert.equal((await unsaved.sent('scene.report')).length, 0, 'an unsaved body plays on but never reports');
    assert.deepEqual(unsaved.errors, []);
  } finally {
    await unsaved.page.close();
  }
});

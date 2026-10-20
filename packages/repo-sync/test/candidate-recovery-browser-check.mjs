import assert from 'node:assert/strict';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Receiver } from '../src/engine.mjs';
import { setIssueToken } from '../src/issue-auth.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { readTask } from '../src/task-store.mjs';
import { recoveryFixture } from './candidate-recovery-fixture.mjs';
import { launchOwnedBrowser } from './owned-browser.mjs';

const cleanup = [];
let f = await recoveryFixture({ after: (fn) => cleanup.push(fn) });
const evidence = join(f.root, 'browser-evidence');
await mkdir(evidence);
process.env.REPO_SYNC_TEST_LEDGER ??= join(evidence, 'instances.jsonl');
let receiver = f.receiver, server, base;
const seenTasks = new Set();
async function start() {
  console.log('[recovery-browser] start isolated server');
  setIssueToken(receiver.config, f.platform.token, 'isolated-browser');
  server = createReceiverServer(receiver, { syncInterval: 3600000 });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
  await lifecycle('running');
}
async function lifecycle(status) {
  await appendFile(process.env.REPO_SYNC_TEST_LEDGER, `${JSON.stringify({ task: 'PR #77 candidate recovery',
    owner: 'Codex regression', component: 'test-server', status, pid: process.pid,
    url: base, stateDir: receiver.config.stateDir, sourceCommit: process.env.REPO_SYNC_SOURCE_COMMIT,
    retention: 'synthetic data/evidence retained; temporary server stopped' })}\n`);
}
async function stop() { if (server?.listening) { await server.shutdown(); await lifecycle('stopped'); } }
async function task(action, status = 'SUCCEEDED') {
  for (let i = 0; i < 1200; i++) {
    const t = await readTask(receiver.config);
    if (t?.action === action && !seenTasks.has(t.id)) {
      if (t.status === status) { seenTasks.add(t.id); return t; }
      if (t.status === 'FAILED') throw Error(JSON.stringify(t.error));
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw Error(`Task ${action} did not settle`);
}
const { browser, close } = await launchOwnedBrowser(chromium, { headless: true, executablePath: chromium.executablePath() });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(60000);
const visit = () => page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await start();
  await visit();
  console.log('[recovery-browser] inspect old candidate');
  await page.locator('[data-action="inspect-exit"]').click();
  await task('inspect-exit');
  const form = page.locator('[data-form="cancel-delivery"]');
  await form.getByRole('checkbox').check();
  f.platform.state.lost = 'pr-close';
  await form.getByRole('button').click();
  await task('cancel-delivery', 'FAILED');
  assert.equal(f.platform.state.prCloses, 1);
  console.log('[recovery-browser] lost close receipt confirmed');
  await page.reload();
  assert.equal(await form.getByRole('checkbox').isChecked(), false);
  await stop();
  receiver = new Receiver(f.config);
  await start();
  await visit();
  await form.getByRole('checkbox').check();
  await form.getByRole('button').click();
  await task('cancel-delivery');
  assert.equal((await receiver.status()).active, undefined);
  assert.equal(f.platform.state.prCloses, 1);
  assert.equal(f.platform.state.creates.issues, 1);
  assert.equal((await receiver.status()).accepted.internal, f.i0);
  await page.reload();
  assert.equal(await page.locator('[data-form="cancel-delivery"]').count(), 0);
  // Explicitly restart the same source; existing Issue is reused, old branch/history retained.
  await receiver.setQueue([f.plan]); await receiver.start(); await receiver.prepare();
  let d = (await receiver.status()).active;
  assert.equal(d.supersedes, f.original.id);
  assert.equal(f.platform.state.creates.issues, 1);
  assert.equal(f.platform.state.creates.prs, 2);
  console.log('[recovery-browser] explicit retry reused Issue');
  // Exercise a persisted old candidate that was merged before its bug was diagnosed.
  await stop();
  f = await recoveryFixture({ after: (fn) => cleanup.push(fn) });
  receiver = f.receiver;
  await f.merge(f.original); f.platform.state.mrs[0].state = 'merged';
  await start(); await visit();
  await page.locator('[data-action="inspect-exit"]').click(); await task('inspect-exit');
  await page.waitForFunction(() => document.querySelector('[data-flow-stage="4"]')?.dataset.flowState === 'done');
  await page.locator('[data-action="preview-repair"]').click(); await task('preview-repair');
  const repairForm = page.locator('[data-form="prepare-repair"]');
  await repairForm.getByRole('checkbox').check();
  await page.screenshot({ path: join(evidence, 'repair-preview-1440.png'), fullPage: true });
  await page.reload();
  assert.equal(await repairForm.getByRole('checkbox').isChecked(), false);
  await repairForm.getByRole('checkbox').check(); await repairForm.getByRole('button').click();
  await task('prepare-repair');
  console.log('[recovery-browser] repair PR published');
  d = (await receiver.status()).active.repair.delivery;
  const creates = f.platform.state.creates.prs;
  await stop(); receiver = new Receiver(f.config); await start(); await visit();
  assert.equal(await page.getByRole('link', { name: '打开修复 PR ↗' }).getAttribute('href'), d.prUrl);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(evidence, 'repair-waiting-390.png'), fullPage: true });
  await f.merge(d); f.platform.state.mrs.at(-1).state = 'merged';
  await page.locator('[data-action="check-repair"]').click(); await task('check-repair');
  const final = await receiver.status();
  assert.equal(final.active, undefined);
  assert.equal(final.deliveries[0].repair.status, 'COMPLETE');
  assert.equal(f.platform.state.creates.prs, creates);
  assert.equal(f.platform.state.creates.issues, 1);
  assert.equal(f.platform.state.closes, 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ outcome: 'PASS', journey: 'exit/lost receipt/restart/retry/repair/restart/accept', evidence }));
} catch (error) {
  console.error('[recovery-browser] failed', error.message);
  await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await close(); await stop(); for (const fn of cleanup) await fn();
}

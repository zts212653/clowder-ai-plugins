import assert from 'node:assert/strict';
import { access, appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createConnection } from '../src/connections.mjs';
import { setIssueToken } from '../src/issue-auth.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { codehubPlatform } from './codehub-fixture.mjs';
import { repositories } from './fixtures.mjs';
import { launchOwnedBrowser } from './owned-browser.mjs';

const f = await repositories(),
  platform = await codehubPlatform(f);
const evidence = await mkdtemp(join(tmpdir(), 'repo-sync-round-panorama-'));
const configPath = join(evidence, 'config.json');
const adapter = { mode: 'gitlab', apiUrl: platform.api, projectId: 'team/core', authMode: 'session' };
await writeFile(
  configPath,
  JSON.stringify({
    ...f.config,
    commitStrategy: 'rewrite',
    internalWebUrl: platform.web,
    issues: adapter,
    pullRequests: adapter,
  }),
);
const connection = await createConnection(configPath),
  receiver = await connection.current();
await receiver.adopt(f.u0, f.i0);
await receiver.setQueue(f.plans);
setIssueToken(receiver.config, platform.token, 'test');
platform.state.pipelineStatus = 'pending';
const server = createReceiverServer(null, { connection, syncInterval: 100 });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port,
  base = `http://127.0.0.1:${port}`;
const instance = (await (await fetch(`${base}/api/status`)).json()).runtime.instanceId;
async function record(status) {
  const value = {
    task: 'repo-sync PR #77',
    owner: 'Codex regression',
    status,
    sourceCommit: process.env.REPO_SYNC_SOURCE_COMMIT,
    packageVersion: '0.1.0-alpha.0',
    executable: process.execPath,
    programDirectory: process.cwd(),
    dataDirectory: evidence,
    pid: process.pid,
    port,
    instanceId: instance,
    fixturePort: Number(new URL(platform.api).port),
    purpose: 'round progress, panorama, unchecked merge and viewport stability',
    retention: 'synthetic data and evidence retained; services close in finally',
    time: new Date().toISOString(),
  };
  await appendFile(
    process.env.REPO_SYNC_TEST_LEDGER ?? join(evidence, 'instances.jsonl'),
    `${JSON.stringify(value)}\n`,
  );
}
await record('running');
const { browser, close } = await launchOwnedBrowser(chromium, { headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let reference;
async function until(predicate) {
  for (let i = 0; i < 900; i++) {
    if (await predicate()) return;
    await page.waitForTimeout(100);
  }
  throw Error('round/panorama journey did not settle');
}
try {
  if (process.env.REPO_SYNC_FLOW_REFERENCE) {
    const html = await readFile(process.env.REPO_SYNC_FLOW_REFERENCE);
    reference = createServer((_q, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    });
    await new Promise((done) => reference.listen(0, '127.0.0.1', done));
    await page.goto(`http://127.0.0.1:${reference.address().port}`);
    await page.screenshot({ path: join(evidence, 'reference.png'), fullPage: true });
    await new Promise((done) => reference.close(done));
    reference = null;
  }
  await page.route('**/workbench-layout.css', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `${await response.text()}\n#project-sidebar { min-height:1100px; }`,
    });
  });
  await page.goto(base);
  const alignment = await page
    .locator('.app-shell')
    .evaluate((e) => ({
      shell: e.getBoundingClientRect().top,
      main: e.querySelector('main').getBoundingClientRect().top,
    }));
  assert.ok(
    Math.abs(alignment.main - alignment.shell) < 2,
    'main must remain top-aligned even with a taller sidebar',
  );
  await page.locator('[data-action="synchronize"]').click();
  await page.getByRole('link', { name: '打开内部 PR ↗', exact: true }).waitFor({ timeout: 30000 });
  await page.locator('[data-round-status="current"]').waitFor();
  assert.equal(await page.locator('[data-round-status="pending"]').count(), 1);
  assert.match(await page.locator('[data-round-slot]').innerText(), /0 \/ 2/);
  assert.match(await page.locator('[data-round-current]').innerText(), /PR #1/);
  await page.locator('[data-round-filter="pending"]').click();
  await page.locator('[data-round-filter="pending"][aria-pressed="true"]').waitFor();
  assert.equal(await page.locator('[data-round-status="pending"]').count(), 1);
  assert.equal(await page.locator('[data-round-status="current"]').count(), 0);
  await page.locator('[data-round-filter="all"]').click();
  await page.locator('[data-round-filter="all"][aria-pressed="true"]').waitFor();
  assert.equal(await page.locator('[data-flow-stage]').count(), 5);
  assert.ok((await page.locator('[data-flow-node]').count()) >= 20);
  await page.locator('[data-persist-details="flow-children-4"] > summary').click();
  await page.locator('[data-flow-node="merge-readiness"]').click();
  await page.locator('[data-stage="4"][open]').waitFor();
  assert.equal(await page.locator('[data-flow-node="merge-readiness"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-stage="4"] [data-step-key="merge-observe"]').isVisible(), false);
  await page.locator('[data-action="pause-sync"]').click();
  await page.getByText(/已设置：本笔完成后暂停/).waitFor();
  const canvasTop = await page.locator('[data-flow-canvas]').evaluate((e) => e.getBoundingClientRect().top);
  const scroll = await page.evaluate(() => scrollY);
  await page.waitForTimeout(5500);
  assert.equal(await page.evaluate(() => scrollY), scroll, 'background polling must not scroll the viewport');
  assert.ok(
    Math.abs(
      (await page.locator('[data-flow-canvas]').evaluate((e) => e.getBoundingClientRect().top)) - canvasTop,
    ) < 2,
  );
  await page.reload();
  await page.locator('[data-stage="4"][open]').waitFor();
  await page.screenshot({ path: join(evidence, 'panorama-current.png'), fullPage: true });
  await page.locator('.auto-merge-options > summary').click();
  await page.locator('.auto-merge-choice [name="autoMerge"]').check();
  await page.getByRole('button', { name: '保存自动合入选择', exact: true }).click();
  await until(async () => (await receiver.status()).active?.autoMerge?.status === 'WAITING');
  await until(async () => {
    try {
      await access(receiver.store.lockPath);
      return false;
    } catch (error) {
      return error.code === 'ENOENT';
    }
  });
  const mr = platform.state.mrs[0];
  mr.merge_status = 'unchecked';
  mr.head_pipeline.status = 'success';
  await receiver.change((s) => {
    s.deliveries[0].autoMerge.nextCheckAt = new Date(0).toISOString();
  });
  await until(async () => (await receiver.status()).automation.status === 'PAUSED');
  await page.locator('[data-round-status="complete"]').waitFor({ timeout: 30000 });
  assert.match(await page.locator('[data-round-slot]').innerText(), /1 \/ 2/);
  assert.equal(platform.state.merges, 1);
  assert.equal(platform.state.creates.prs, 1);
  platform.state.pipelineStatus = 'pending';
  await until(async () => {
    try {
      await access(receiver.store.lockPath);
      return false;
    } catch (error) {
      return error.code === 'ENOENT';
    }
  });
  await page.locator('[data-round-status="complete"] [data-record]').click();
  await page.getByText('历史记录 · 只读', { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回当前同步', exact: true }).click();
  await page.getByRole('button', { name: '继续下一笔同步 →', exact: true }).click();
  await until(
    async () =>
      (await receiver.status()).active?.source?.number === 2 &&
      (await receiver.status()).active?.autoMerge?.status === 'WAITING',
  );
  await page.locator('[data-round-current]').filter({ hasText: 'PR #2' }).waitFor({ timeout: 30000 });
  assert.equal(
    await page.locator('[data-stage][open]').count(),
    0,
    'the next delivery must not inherit the first delivery inspector',
  );
  platform.state.mrs[1].head_pipeline.status = 'success';
  await receiver.change((s) => {
    s.deliveries[1].autoMerge.nextCheckAt = new Date(0).toISOString();
  });
  await until(
    async () =>
      (await receiver.status()).automation.status === 'COMPLETE' &&
      (await receiver.status()).deliveries.length === 2,
  );
  await page.locator('[data-round-slot]').filter({ hasText: '2 / 2' }).waitFor();
  assert.equal(platform.state.merges, 2);
  assert.equal(platform.state.closes, 1);
  for (const width of [1440, 1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(evidence, `complete-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log(
    `PASS: round list, top-aligned panorama, stable polling, history, lazy unchecked merge and exactly-once continuation. Evidence: ${evidence}`,
  );
} finally {
  await close();
  if (reference) await new Promise((done) => reference.close(done));
  await server.shutdown();
  await platform.close();
  await record('stopped');
}

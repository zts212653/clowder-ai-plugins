import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createConnection } from '../src/connections.mjs';
import { setIssueToken } from '../src/issue-auth.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { codehubPlatform } from './codehub-fixture.mjs';
import { repositories } from './fixtures.mjs';
import { openAutoMerge } from './journey-controls.mjs';
import { launchOwnedBrowser } from './owned-browser.mjs';

const f = await repositories(),
  platform = await codehubPlatform(f);
const root = await mkdtemp(join(tmpdir(), 'repo-sync-wait-ui-'));
const file = join(root, 'config.json'),
  evidence = process.env.REPO_SYNC_EVIDENCE ?? root;
await mkdir(evidence, { recursive: true });
const adapter = {
  mode: 'gitlab',
  apiUrl: platform.api,
  projectId: 'team/core',
  authMode: 'session',
};
await writeFile(
  file,
  JSON.stringify({
    ...f.config,
    commitStrategy: 'rewrite',
    receivingIdentity: {
      name: 'Internal Operator',
      email: 'operator@example.invalid',
    },
    internalWebUrl: platform.web,
    pullRequests: adapter,
    issues: adapter,
  }),
);
let connection = await createConnection(file),
  receiver = await connection.current();
setIssueToken(receiver.config, platform.token, 'test');
await receiver.adopt(f.u0, f.i0);
await receiver.setQueue(f.plans);
platform.state.pipelineStatus = 'pending';
let server = createReceiverServer(null, { connection, syncInterval: 100 });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port,
  base = `http://127.0.0.1:${port}`;
const { browser, close } = await launchOwnedBrowser(chromium, {
  headless: true,
  executablePath: process.env.REPO_SYNC_CHROME,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto(base);
  await page.locator('[data-action="synchronize"]').click();
  await page.getByRole('link', { name: '打开内部 PR ↗', exact: true }).waitFor({ timeout: 30000 });
  await openAutoMerge(page);
  await page.locator('.auto-merge-choice [name="autoMerge"]').check();
  // Polling and refresh retain the draft without granting merge authority.
  await page.locator('.auto-merge-choice [name="autoMerge"]').blur();
  await page.waitForTimeout(5500);
  assert.equal(await page.locator('.auto-merge-choice [name="autoMerge"]').isChecked(), true);
  assert.equal((await receiver.status()).automation.autoMerge, false);
  await page.reload();
  await openAutoMerge(page);
  assert.equal(await page.locator('.auto-merge-choice [name="autoMerge"]').isChecked(), true);
  await page.locator('.auto-merge-choice [data-edit-note]:not([hidden])').waitFor();
  await page.getByRole('button', { name: '保存自动合入选择', exact: true }).click();
  await page.locator('[data-flow-stage="4"][data-flow-state="waiting-system"]').waitFor({ timeout: 30000 });
  assert.equal(platform.state.merges, 0);
  for (let i = 0; i < 300 && (await receiver.status()).automation.status !== 'WAITING_REVIEW'; i++)
    await page.waitForTimeout(50);
  assert.equal((await receiver.status()).automation.status, 'WAITING_REVIEW');
  assert.equal(await page.locator('[data-stage][open]').count(), 0);
  const keys = await page.locator('[data-step-key]').evaluateAll((n) => n.map((i) => i.dataset.stepKey));
  await page.reload();
  await page.locator('[data-flow-stage="4"][data-flow-state="waiting-system"]').waitFor();
  await page.locator('.auto-merge-choice').first().waitFor({ state: 'visible' });
  assert.deepEqual(
    await page.locator('[data-step-key]').evaluateAll((n) => n.map((i) => i.dataset.stepKey)),
    keys,
  );
  for (const [width, height] of [
    [1440, 900],
    [1366, 768],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => scrollTo(0, 0));
    const bottom = await page
      .locator('[data-flow-stage-select="5"]')
      .evaluate((e) => e.getBoundingClientRect().bottom);
    await page.screenshot({ path: join(evidence, `phase-headers-${width}.png`), fullPage: true });
    assert.ok(bottom <= height, `all five phase headings fit ${width}x${height}: ${bottom}`);
    assert.ok(
      (await page.getByRole('link', { name: '打开内部 PR ↗', exact: true }).boundingBox()).y < height,
    );
  }
  await page.screenshot({
    path: join(evidence, 'ci-wait-workbench.png'),
    fullPage: true,
  });
  platform.state.denied = true;
  await receiver.change((s) => { s.deliveries[0].autoMerge.nextCheckAt = new Date(0).toISOString(); });
  for (let i = 0; i < 300 && (await receiver.status()).automation.status !== 'FAILED'; i++)
    await page.waitForTimeout(50);
  assert.equal((await receiver.status()).automation.status, 'FAILED');
  setIssueToken(receiver.config, '', 'test');
  await page.reload();
  assert.equal(await page.locator('[data-stage][open]').count(), 0);
  await page.locator('.next-action [data-repair="platform"]').click();
  await page.locator('[data-settings-form]').waitFor();
  assert.equal(await page.locator('.flow.setup,#operation').count(), 0);
  assert.equal(await page.getByLabel('内部 Git 姓名').inputValue(), 'Internal Operator');
  assert.equal(await page.getByLabel('提交处理方式').isDisabled(), true);
  assert.match(await page.locator('#issue-auth [data-auth-status]').innerText(), /未提供/);
  platform.state.denied = false;
  await page.getByLabel('内部平台 Token', { exact: true }).fill(platform.token);
  await page.locator('#issue-auth').getByRole('button', { name: '保存 Token 到本次服务', exact: true }).click();
  await page.locator('#issue-auth [data-auth-status="provided"]').waitFor();
  await page.locator('#issue-auth').getByRole('button', { name: '只读验证内部接口', exact: true }).click();
  try {
    await page.locator('#issue-auth [data-auth-status="verified"]').waitFor({ timeout: 30000 });
  } catch (error) {
    console.log('[browser-test] issue-auth feedback:', await page.locator('#issue-auth [data-auth-feedback]').innerText());
    throw error;
  }
  assert.doesNotMatch(await readFile(file, 'utf8'), /SYNTHETIC_BROWSER_TOKEN/);
  await page.getByRole('button', { name: '继续原同步 →', exact: true }).click();
  await page.locator('[data-flow-stage="4"][data-flow-state="waiting-system"]').waitFor({ timeout: 30000 });
  assert.equal(platform.state.creates.prs, 1);
  await page.getByRole('button', { name: '仓库设置', exact: true }).click();
  for (const width of [1440, 1366, 1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({
      path: join(evidence, `settings-${width}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.getByRole('button', { name: '同步工作台', exact: true }).click();
  await page.getByRole('button', { name: '本笔完成后暂停', exact: true }).click();
  await page.getByText(/已设置：本笔完成后暂停/).waitFor();
  await page.goto('about:blank');
  await server.shutdown();
  connection = await createConnection(file);
  receiver = await connection.current();
  platform.state.mrs[0].head_pipeline.status = 'success';
  await receiver.change((s) => {
    s.deliveries[0].autoMerge.nextCheckAt = new Date(0).toISOString();
  });
  server = createReceiverServer(null, { connection, syncInterval: 100 });
  await new Promise((done) => server.listen(port, '127.0.0.1', done));
  await page.goto(base);
  await page.getByRole('button', { name: '仓库设置', exact: true }).click();
  assert.match(await page.locator('#issue-auth [data-auth-status]').innerText(), /未提供/);
  await page.getByLabel('内部平台 Token', { exact: true }).fill(platform.token);
  await page.locator('#issue-auth').getByRole('button', { name: '保存 Token 到本次服务', exact: true }).click();
  await page.locator('#issue-auth').getByRole('button', { name: '只读验证内部接口', exact: true }).click();
  await page.locator('#issue-auth [data-auth-status="verified"]').waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '同步工作台', exact: true }).click();
  await page.getByRole('button', { name: '继续下一笔同步 →', exact: true }).waitFor({ timeout: 30000 });
  const result = await receiver.status();
  assert.equal(result.deliveries.length, 1);
  assert.equal(result.deliveries[0].status, 'COMPLETE');
  assert.equal(result.deliveries[0].mergeObservation.source, 'platform');
  assert.equal(platform.state.merges, 1);
  assert.equal(platform.state.creates.prs, 1);
  assert.equal(await page.locator('[data-stage="4"]').getAttribute('data-stage-state'), 'done');
  await page.screenshot({
    path: join(evidence, 'after-restart-accepted.png'),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    `PASS: CI automatic wait, stable collapsed nodes, unified settings and private credential save, four widths, same-port restart, single merge and accepted pause boundary. Evidence: ${evidence}`,
  );
} finally {
  await close();
  await server.shutdown();
  await platform.close();
}

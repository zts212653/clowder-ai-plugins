import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Receiver } from '../src/engine.mjs';
import { git } from '../src/process.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { gitPrFixture } from './git-pr-fixtures.mjs';
import { openHistory } from './journey-controls.mjs';
import { launchOwnedBrowser } from './owned-browser.mjs';

const f = await gitPrFixture();
const receiver = new Receiver(f.config);
await receiver.adopt(f.u0, f.i0);
const server = createReceiverServer(receiver, { syncInterval: 100 });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const { browser, close: closeBrowser } = await launchOwnedBrowser(chromium, {
  headless: true,
  executablePath: process.env.REPO_SYNC_CHROME,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const evidence = process.env.REPO_SYNC_EVIDENCE || join(tmpdir(), 'repo-sync-journey-evidence');
const errors = [];
let releaseCheck = () => {};
page.on('pageerror', (error) => errors.push(error.message));
await mkdir(evidence, { recursive: true });
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await openHistory(page);
  await page.locator('.record-list').waitFor({ timeout: 3000 });
  await page.getByRole('button', { name: '读取可用 tag', exact: true }).click();
  await page.locator('[name="tag"]').selectOption('v2.0.0');
  await page.getByRole('button', { name: '同步到所选版本 →' }).click();
  await page.getByRole('link', { name: '打开内部 PR ↗', exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.locator('[data-stage]').count(), 5);
  assert.equal(await page.locator('main > #operation').count(), 0, 'execution belongs inside a stage');
  const active = (await receiver.status()).active;
  await f.merge(active);
  await page.getByRole('heading', { name: '当前已接收版本', exact: true }).waitFor({ timeout: 30000 });
  const accepted = (await receiver.status()).accepted;
  const completedTasks = (await receiver.status()).deliveries[0].taskIds.slice();
  assert.equal(accepted.tag, 'v2.0.0');
  await openHistory(page);
  await page.locator(`.records-page [data-record="${active.id}"]`).click();
  await page.getByText('历史记录 · 只读', { exact: true }).waitFor();
  assert.equal(await page.locator('.records-detail [data-action]').count(), 0);
  await page.locator('.delivery-boundary > summary').click();
  assert.ok((await page.locator('.records-detail').innerText()).includes(accepted.internal));
  assert.ok((await page.locator('.records-detail').innerText()).includes(f.u0));
  await page.getByRole('button', { name: '展开全部阶段' }).click();
  assert.ok((await page.locator('[data-attempt]').count()) >= 2);
  await page.getByText('当时配置与来源', { exact: true }).click();
  assert.ok((await page.locator('.records-detail').innerText()).includes('releases'));
  await page.reload();
  await page.getByText('历史记录 · 只读', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('record'), active.id);
  for (const width of [1440, 769, 768, 767, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (width <= 768) {
      await page.getByRole('button', { name: '返回同步记录' }).click();
      await openHistory(page);
      await page.locator(`.records-page [data-record="${active.id}"]`).click();
    }
    if ([1440, 390].includes(width))
      await page.screenshot({
        path: join(evidence, `history-${width}.png`),
        fullPage: true,
      });
  }
  await page.getByRole('button', { name: '展开全部阶段' }).click();
  const dimensions = await page.locator('.record-list button').evaluateAll((buttons) =>
    buttons
      .map((item) => ({
        width: item.getBoundingClientRect().width,
        height: item.getBoundingClientRect().height,
      }))
      .filter((item) => item.width),
  );
  assert.ok(dimensions.every((item) => item.width >= 44 && item.height >= 44));
  await writeFile(join(f.source, 'README.md'), '上游第三版介绍\n\n运行说明\n\n联系说明\n');
  await git(f.source, ['add', '.']);
  await git(f.source, ['commit', '-m', 'third synthetic release']);
  await git(f.source, ['tag', 'v3.0.0']);
  await writeFile(join(f.review, 'README.md'), '内部第三版介绍\n\n运行说明\n\n内部联系说明\n');
  await git(f.review, ['add', '.']);
  await git(f.review, ['commit', '-m', 'third internal customization']);
  await git(f.review, ['push', 'origin', 'main']);
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByRole('button', { name: '返回当前同步', exact: true }).click();
  await page.getByRole('button', { name: '读取可用 tag', exact: true }).click();
  await page.locator('[name="tag"]').selectOption('v3.0.0');
  assert.deepEqual(
    (await receiver.status()).deliveries[0].taskIds,
    completedTasks,
    'new selection cannot rewrite completed history',
  );
  const originalChecks = receiver.git.checks.bind(receiver.git);
  let failCheck = true;
  receiver.git.checks = async (head) => {
    if (failCheck) {
      failCheck = false;
      throw Object.assign(new Error('synthetic one-time check failure'), {
        code: 'COMMAND_FAILED',
      });
    }
    return originalChecks(head);
  };
  await page.getByRole('button', { name: '同步到所选版本 →' }).click();
  await page.locator('[data-flow-stage="2"][data-flow-state="failed"]').waitFor({ timeout: 30000 });
  const failedCandidate = (await receiver.status()).active.candidate;
  await openHistory(page);
  await page.locator(`.records-page [data-record="${active.id}"]`).click();
  await page.getByRole('button', { name: '返回当前同步', exact: true }).click();
  await page.locator('[data-flow-stage="2"][data-flow-state="failed"]').waitFor({ timeout: 30000 });
  await page.reload();
  await page.locator('[data-flow-stage="2"][data-flow-state="failed"]').waitFor({ timeout: 30000 });
  assert.equal(await page.locator('[data-flow-stage="2"][data-flow-state="failed"]').count(), 1);
  assert.equal((await receiver.status()).active.candidate, failedCandidate);
  assert.equal(await page.locator('[data-form="resolve"], [name="mergePaths"]').count(), 0);
  const checks = receiver.git.checks.bind(receiver.git);
  const gate = new Promise((done) => {
    releaseCheck = done;
  });
  let checking = false;
  receiver.git.checks = async (head) => {
    checking = true;
    await gate;
    return checks(head);
  };
  await page.getByRole('button', { name: '恢复原同步 →' }).click();
  await page.waitForFunction(() => document.querySelector('[data-operation-state="RUNNING"]'));
  await openHistory(page);
  await page.locator(`.records-page [data-record="${active.id}"]`).click();
  await page.getByText('历史记录 · 只读', { exact: true }).waitFor();
  assert.equal(await page.locator('.record-list input[name="q"]').isDisabled(), false);
  for (let retry = 0; retry < 100 && !checking; retry++) await new Promise((done) => setTimeout(done, 100));
  assert.ok(checking);
  releaseCheck();
  await page.waitForFunction(() => document.getElementById('current-activity')?.textContent === '');
  assert.equal(
    new URL(page.url()).searchParams.get('record'),
    active.id,
    'background completion must not steal history',
  );
  await page.getByRole('button', { name: '返回当前同步', exact: true }).click();
  await page.getByRole('link', { name: '打开内部 PR ↗', exact: true }).waitFor({ timeout: 30000 });
  assert.equal(
    await page.locator('[data-stage="2"] [data-step-key="candidate-check"] [data-attempt]').count(),
    2,
    'one failed check and one recovery remain visible without a removed resolution action',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.next-action').scrollIntoViewIfNeeded();
  const bar = await page.locator('.next-action').boundingBox();
  assert.ok(bar.y + bar.height <= 844 && bar.y > 0);
  await page.screenshot({
    path: join(evidence, 'current-390.png'),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: real Git tag/automatic PR/merge, unified nested timeline, lazy read-only history, snapshots/attempt times, reload and responsive same-page navigation.',
  );
} catch (error) {
  console.log('Browser errors:', errors, '\nVisible page:', await page.locator('body').innerText());
  await page.screenshot({
    path: join(evidence, 'failure.png'),
    fullPage: true,
  });
  throw error;
} finally {
  releaseCheck();
  await closeBrowser();
  await server.shutdown();
}

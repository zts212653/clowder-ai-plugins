import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Receiver } from '../src/engine.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { repositories } from './fixtures.mjs';
import { openStage } from './journey-controls.mjs';
import { launchOwnedBrowser } from './owned-browser.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.REPO_SYNC_PLAYWRIGHT || 'playwright');
const evidence = process.env.REPO_SYNC_EVIDENCE || join(tmpdir(), 'repo-sync-git-evidence');
await mkdir(evidence, { recursive: true });
const fixture = await repositories();
const receiver = new Receiver(fixture.config);
await receiver.adopt(fixture.u0, fixture.i0);
await receiver.setQueue(fixture.plans);
const server = createReceiverServer(receiver);
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const { browser, close: closeBrowser } = await launchOwnedBrowser(chromium, {
  host: '127.0.0.1',
  headless: true,
  ...(process.env.REPO_SYNC_CHROME ? { executablePath: process.env.REPO_SYNC_CHROME } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [],
  posted = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => {
  if (!request.url().endsWith('/api/tasks') || request.method() !== 'POST') return;
  const input = request.postDataJSON();
  posted.push(input.action);
  if (input.action === 'receipts') {
    assert.equal(input['issue-71'], undefined);
    assert.match(input.deliveryId, /^[a-f0-9]{24}$/);
    assert.equal(input.observations.length, 1);
  }
});
try {
  try {
    await page.goto(base);
  } catch (error) {
    if (!error.message.includes('net::ERR_ABORTED')) throw error;
    console.warn('Retrying initial read-only navigation after ERR_ABORTED.');
    await page.goto(base);
  }
  for (let index = 0; index < 2; index++) {
    await page.locator('[data-action="start"]').click();
    await page.locator('[data-flow-stage="2"]').waitFor({ state: 'attached' });
    await openStage(page, 2);
    if (!index) {
      await page.getByLabel('内部 Issue 编号').fill('318');
      await page.getByLabel('内部 Issue 具体链接').fill('https://codehub.example/core/issues/318');
      await page.getByRole('button', { name: '保存此 Issue 映射' }).click();
    } else assert.equal(await page.locator('[data-form="issue"]').count(), 0);
    if (!index)
      await page.evaluate(() => {
        // A status poll can repaint the same action while its click awaits navigation.
        const repaint = (event) => {
          const button = event.target.closest('[data-action="prepare"]');
          if (!button) return;
          document.removeEventListener('click', repaint, true);
          const footer = button.closest('.next-action');
          footer.replaceWith(footer.cloneNode(true));
          document.documentElement.dataset.prepareRepainted = String(!button.isConnected);
        };
        document.addEventListener('click', repaint, true);
      });
    await page.locator('[data-action="prepare"]').click();
    const prStage = page.locator('[data-stage="3"]');
    await prStage.waitFor({ state: 'attached' });
    if (!(await prStage.evaluate((node) => node.open))) await openStage(page, await prStage.getAttribute('data-stage'));
    await page.locator('[data-form="pr"]').waitFor({ timeout: 20000 });
    if (!index) assert.equal(await page.locator('html').getAttribute('data-prepare-repainted'), 'true');
    const before = await receiver.status();
    assert.equal((await receiver.git.fetch()).internal, before.accepted.internal);
    assert.match(before.templates.body, /内部 #318/);
    assert.equal(
      await page.locator('[data-stage-state="done"]').count(),
      2,
      'scope and preparation finished; publication waits for PR reference',
    );
    await page.getByLabel('内部 PR 具体链接').fill(`https://codehub.example/core/pull/${index + 1}`);
    await page.locator('[data-pr-confirm]').check();
    await page.getByRole('button', { name: '登记 PR，进入审核' }).click();
    await fixture.merge((await receiver.status()).active);
    await page.reload();
    assert.equal((await receiver.status()).accepted.internal, before.accepted.internal);
    await page.getByRole('button', { name: '已在平台合入，核验 Git 结果' }).click();
    const receiptStage = page.locator('[data-stage="5"]');
    await receiptStage.waitFor({ state: 'attached' });
    if (!(await receiptStage.evaluate((node) => node.open)))
      await openStage(page, await receiptStage.getAttribute('data-stage'));
    await page.locator('[data-form="receipts"]').waitFor({ timeout: 20000 });
    if (index) {
      await page.getByRole('button', { name: '保存本笔接收记录，完成同步' }).click();
      await page.locator('#error').waitFor({ state: 'visible' });
      assert.match(await page.locator('#error').innerText(), /ISSUE_UPDATE_PENDING/);
      assert.equal(await page.locator('[data-step-state="failed"]').count(), 1);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: join(evidence, '27-git-metadata-error-mobile.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 1440, height: 1100 });
      await page.locator('[data-form="receipts"] select').selectOption('closed');
    }
    await page.getByRole('button', { name: '保存本笔接收记录，完成同步' }).click();
    if (index) await page.getByRole('heading', { name: '本轮交付已完成' }).waitFor();
    else await page.locator('[data-action="start"]').waitFor();
    const after = await receiver.status();
    assert.equal(after.deliveries[index].status, 'COMPLETE');
    assert.equal(after.issues['issue-71'].state, index ? 'closed' : 'open');
    assert.equal(after.issues['issue-71'].receipts.length, index + 1);
    if (!index) {
      await page.locator('details').first().locator(':scope > summary').click();
      await page.screenshot({
        path: join(evidence, '26-git-shared-issue-u1.png'),
        fullPage: true,
      });
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS：真实 Git 两笔接收、Issue 映射复用、具体 PR 页面、合入后游标恢复、元数据失败 ×、U1 open / U2 closed 与移动端。',
  );
} catch (error) {
  const state = await receiver.status();
  console.error(
    'Browser failure diagnostics:',
    JSON.stringify({
      failure: error.message,
      errors,
      posted,
      active: state?.active && {
        id: state.active.id,
        status: state.active.status,
      },
      forms: await page.locator('[data-form="pr"]').count(),
      stages: await page.locator('[data-stage]').evaluateAll((nodes) =>
        nodes.map((node) => ({
          stage: node.dataset.stage,
          state: node.dataset.stageState,
          open: node.open,
        })),
      ),
    }),
  );
  await page.screenshot({
    path: join(evidence, 'browser-failure.png'),
    fullPage: true,
  });
  throw error;
} finally {
  try {
    await closeBrowser();
  } finally {
    await server.shutdown();
  }
}

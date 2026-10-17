import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createConnection } from '../src/connections.mjs';
import { Receiver } from '../src/engine.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { gitPrFixture } from './git-pr-fixtures.mjs';
import { openStage } from './journey-controls.mjs';
import { launchOwnedBrowser } from './owned-browser.mjs';

const f = await gitPrFixture();
const folder = await fs.mkdtemp(join(tmpdir(), 'repo-sync-audit-web-'));
const configFile = join(folder, 'config.json');
await fs.writeFile(configFile, JSON.stringify(f.config));
const initial = new Receiver(f.config);
await initial.adopt(f.u0, f.i0);
await initial.selectTag('v2.0.0');
const connection = await createConnection(configFile);
const server = createReceiverServer(null, { connection, syncInterval: 100 });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const { browser, close: closeBrowser } = await launchOwnedBrowser(chromium, {
  host: '127.0.0.1',
  headless: true,
  executablePath: process.env.REPO_SYNC_CHROME,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const evidence = process.env.REPO_SYNC_EVIDENCE || join(tmpdir(), 'repo-sync-audit-evidence');
await fs.mkdir(evidence, { recursive: true });
let original;
let startPosts = 0;
await page.route('**/api/tasks', async (route) => {
  const input = route.request().postDataJSON();
  if (input.action === 'synchronize') {
    startPosts++;
    if (!original) {
      original = input;
      return route.abort('failed');
    }
    assert.deepEqual(input, original, 'explicit resend must preserve the complete original intent');
  }
  return route.continue();
});
const rename = fs.rename;
let denyTerminal = false;
fs.rename = async (from, to) => {
  if (denyTerminal && /[\\/]operations[\\/][a-f0-9]{32}\.json$/.test(to)) {
    const value = JSON.parse(await fs.readFile(from, 'utf8'));
    if (value.status === 'SUCCEEDED')
      throw Object.assign(new Error('private occupied file'), {
        code: 'EPERM',
      });
  }
  return rename(from, to);
};
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('[data-action="synchronize"]').click();
  await page.getByRole('button', { name: '重送原请求（保持同一标识）' }).waitFor();
  assert.equal(startPosts, 1);
  assert.equal((await initial.status()).deliveries.length, 0);
  assert.equal(original.expectedTarget, f.u1);
  await page.screenshot({
    path: join(evidence, 'same-request-resend.png'),
    fullPage: true,
  });
  denyTerminal = true;
  await page.getByRole('button', { name: '重送原请求（保持同一标识）' }).click();
  const failedStage = page.locator('[data-stage="5"]');
  await failedStage.waitFor({ state: 'attached' });
  assert.equal(await failedStage.evaluate((element) => element.open), false);
  await openStage(page, await failedStage.getAttribute('data-stage'));
  const failedRecord = page.locator('[data-step-key="execution-record"][data-step-state="failed"]');
  await failedRecord.waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '只补存原任务记录', exact: true }).waitFor();
  assert.equal(startPosts, 2);
  const receiver = await connection.current();
  assert.equal((await receiver.status()).deliveries.length, 1);
  const failed = await (await fetch(new URL('/api/status', page.url()))).json();
  assert.equal(failed.operation.status, 'SUCCEEDED');
  assert.equal(failed.operation.persistence.status, 'FAILED');
  assert.match(await page.locator('.next-action').innerText(), /只补存原记录，不能重跑业务/);
  assert.equal((await receiver.status()).active.status, 'WAITING_APPROVAL');
  assert.equal(JSON.parse(await fs.readFile(f.resultFile)).count, 1);
  assert.equal(
    await page.locator('[data-action="recover"]').count(),
    0,
    'pending record exposes only record repair',
  );
  await page.reload();
  const restoredFailureStage = page.locator('[data-stage="5"]');
  await restoredFailureStage.waitFor({ state: 'attached' });
  assert.equal(await restoredFailureStage.evaluate((element) => element.open), true);
  await failedRecord.waitFor();
  await page.getByRole('button', { name: '只补存原任务记录', exact: true }).waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('[data-stage="5"]').screenshot({ path: join(evidence, `record-repair-${width}.png`) });
  }
  denyTerminal = false;
  await page.getByRole('button', { name: '只补存原任务记录' }).click();
  await page.getByRole('button', { name: '只补存原任务记录', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('link', { name: '打开内部 PR ↗', exact: true }).isVisible(), true);
  assert.equal(JSON.parse(await fs.readFile(f.resultFile)).count, 1);
  if (!(await page.locator('[data-stage="3"]').evaluate((element) => element.open)))
    await openStage(page, 3);
  await page.getByText('链接填错了？纠正或撤销引用').click();
  await page.locator('[data-form="clear-pr"] input[type="checkbox"]').check();
  await page.getByRole('button', { name: '撤销错误引用，返回 PR 创建步骤' }).click();
  await page.getByRole('heading', { name: '登记核对后的 PR 引用' }).waitFor({ timeout: 20000 });
  assert.equal(await page.locator('[data-action="create-pr"]').count(), 0);
  await assert.rejects(() => receiver.recover(), {
    code: 'PR_REFERENCE_WITHDRAWN',
  });
  await page.reload();
  await page.getByRole('heading', { name: '登记核对后的 PR 引用' }).waitFor();
  assert.equal((await receiver.status()).active.prUrl, undefined);
  assert.equal(JSON.parse(await fs.readFile(f.resultFile)).count, 1);
  await page.getByLabel('内部 PR 具体链接').fill('https://codehub.example/core/-/merge_requests/501');
  await page.locator('[data-pr-confirm]').check();
  await page.getByRole('button', { name: '登记 PR，进入审核' }).click();
  await page.getByRole('button', { name: '恢复原同步 →' }).click();
  await page.getByRole('link', { name: '打开内部 PR ↗', exact: true }).waitFor({ timeout: 20000 });
  await f.merge((await receiver.status()).active);
  await page.getByRole('heading', { name: '当前已接收版本' }).waitFor({ timeout: 30000 });
  assert.equal((await receiver.status()).accepted.tag, 'v2.0.0');
  assert.equal(JSON.parse(await fs.readFile(f.resultFile)).count, 1);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: lost request before admission resends identical intent once; final record failure survives reload; record-only repair leaves one Git PR; withdrawn receipt stays withdrawn; re-register and real Git merge; 1440/390.',
  );
} finally {
  fs.rename = rename;
  try {
    await page.close();
    await closeBrowser();
  } finally {
    await server.shutdown();
  }
}

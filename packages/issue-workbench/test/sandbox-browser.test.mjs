import { expandSection } from './helpers/expand-section.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startSandbox } from '../scripts/sandbox/server.mjs';

test('manual sandbox: persistent authored plan, simulated analysis and explicit two-member receipt', { timeout: 90000 }, async t => {
  const output = resolve('artifacts/interactive-sandbox-2026-10-21'); await mkdir(output, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), 'issue-sandbox-browser-'));
  const app = await startSandbox({ root, hostRoot: process.env.ISSUE_WORKBENCH_HOST_ROOT,
    archive: process.env.ISSUE_WORKBENCH_HOST_ARCHIVE, port: 0, automatic: false });
  t.after(() => app.close());
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(app.url);
  await page.getByText('隔离模拟试用', { exact: true }).waitFor();
  const sender = page.frameLocator('#sender-frame');
  const plan = '用户亲手写入的方案 sentinel-83c9：先复现再讨论。';
  await expandSection(sender, '补充分析（可选）');
  await sender.getByLabel('分析备注', { exact: true }).fill(plan);
  try {
    const [saved] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/work')), sender.getByRole('button', { name: '保存分析', exact: true }).click()]);
    assert.ok(saved.ok());
  } catch (e) {
    await page.screenshot({ path: join(output, 'save-failure.png'), fullPage: true });
    t.diagnostic(await sender.locator('body').innerText()); throw e;
  }
  await page.reload();
  assert.equal(await sender.getByLabel('分析备注', { exact: true }).inputValue(), plan);
  await sender.getByRole('button', { name: '猫猫研判', exact: true }).click();
  await sender.getByRole('button', { name: '请猫分析', exact: true }).click();
  await sender.getByText('已发送，等待研判', { exact: true }).waitFor();
  await page.getByText('模拟设置与故障恢复', { exact: true }).click();
  await page.getByRole('button', { name: '执行一次同步', exact: true }).click();
  await sender.getByText('9 / 10', { exact: true }).first().waitFor();
  await sender.getByLabel('派工方式', { exact: true }).selectOption('invitation');
  await sender.getByRole('button', { name: '通知成员接手', exact: true }).click();
  await sender.getByRole('button', { name: '确认发送邀请', exact: true }).click();
  await sender.getByText('任务邀请已发布，等待成员接手', { exact: true }).waitFor();
  await page.getByRole('button', { name: '执行一次同步', exact: true }).click();
  await page.getByRole('button', { name: '接收端 · alice', exact: true }).click();
  await page.locator('#inbox option').filter({ hasText: '#1' }).waitFor({ state: 'attached' });
  const receipt = '我明确接手 sentinel-3ef8，先验证复现步骤。';
  await page.getByLabel('回报说明', { exact: true }).fill(receipt);
  await page.getByRole('button', { name: '发送模拟回执', exact: true }).click();
  await page.getByText('模拟回执已保存并发布：明确接手 · ' + receipt, { exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'receiver-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '发送端 · bob', exact: true }).click();
  await sender.getByRole('button', { name: '刷新团队结果', exact: true }).click();
  await sender.getByText(receipt, { exact: true }).waitFor();
  await page.screenshot({ path: join(output, 'sender-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText('模拟设置与故障恢复', { exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await sender.locator('iframe').count(), 0);
  assert.equal(await sender.getByText('隔离模拟试用', { exact: true }).count(), 0);
  await page.screenshot({ path: join(output, 'mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  t.diagnostic('Browser input, invitation and explicit receipt verified; retained data: ' + root);
});

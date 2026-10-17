import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Receiver } from '../src/engine.mjs';
import { git } from '../src/process.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { configuredReceiver } from '../src/settings.mjs';
import { openHistory, openStage } from './journey-controls.mjs';
import { launchOwnedBrowser } from './owned-browser.mjs';
import { activateBaseline } from './setup-journey-helpers.mjs';
import { versionRepositories } from './version-fixtures.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.REPO_SYNC_PLAYWRIGHT || 'playwright');
const evidence = process.env.REPO_SYNC_EVIDENCE || join(tmpdir(), 'repo-sync-version-evidence');
await mkdir(evidence, { recursive: true });
const { browser, close: closeBrowser } = await launchOwnedBrowser(chromium, {
  headless: true,
  ...(process.env.REPO_SYNC_CHROME ? { executablePath: process.env.REPO_SYNC_CHROME } : {}),
});
try {
  for (const conflicting of [false, true]) {
    const f = await versionRepositories();
    await git(f.source, ['switch', '-c', 'main-like', f.u0]);
    await git(f.source, ['commit', '--allow-empty', '-m', 'source branch without release tag']);
    f.config.sourceBranch = 'main-like';
    if (conflicting) {
      await writeFile(join(f.review, 'README.md'), '内部新版介绍\n\n运行说明\n\n内部联系说明\n');
      await git(f.review, ['add', '.']);
      await git(f.review, ['commit', '-m', 'synthetic additional internal customization']);
      await git(f.review, ['push', 'origin', 'main']);
      f.i0 = await git(f.review, ['rev-parse', 'HEAD']);
    }
    const server = createReceiverServer(
      new Receiver({
        ...f.config,
        mode: 'continuous',
        internalPaths: [],
        mergePaths: [],
      }),
    );
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/tasks') || request.method() !== 'POST') return;
      const input = request.postDataJSON();
      assert.notEqual(input.action, 'resolve');
    });
    try {
      await page.goto(base);
      await page.getByRole('button', { name: '配置同步基线 →' }).click();
      await page.getByText('✓ 1 · 仓库信息已保存', { exact: true }).click();
      await page.getByLabel('同步模式', { exact: true }).selectOption('version');
      await page.getByText('手动填写路径（高级）', { exact: true }).click();
      await page.getByLabel('内部保留文件 / 目录（每行一项）').fill('internal-docs/\nOWNED.md\nREADME.md');
      assert.equal(await page.locator('[name="mergePaths"]').count(), 0);
      await page.getByRole('button', { name: '保存同步方式与规则' }).click();
      await page.getByText('同步方式与文件规则已保存，请登记已有基线。').waitFor();
      await page.getByLabel('上次已经接收的外部版本').fill(f.u0);
      await page.getByLabel('内部当前接收位置').fill(f.i0);
      await page.getByRole('button', { name: '核验起点并查看文件 →' }).click();
      await page.getByRole('button', { name: '继续确认启用 →' }).waitFor({ timeout: 30000 });
      await activateBaseline(page);
      await page.getByRole('button', { name: '读取可用 tag' }).click();
      const selector = page.locator('select[name="tag"]');
      await selector.waitFor();
      const size = await selector.evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        height: element.getBoundingClientRect().height,
        formWidth: element.form.getBoundingClientRect().width,
        font: Number.parseFloat(getComputedStyle(element).fontSize),
      }));
      assert.ok(size.height >= 48 && size.font >= 16, 'tag selector needs a readable 48px control');
      assert.ok(
        size.width >= Math.min(480, size.formWidth - 2),
        'tag selector must use the available form width',
      );
      await page.screenshot({
        path: join(evidence, 'tag-selector-desktop.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      if (!(await selector.isVisible())) {
        await openHistory(page);
        await page.locator('[data-record="current"]').click();
      }
      const mobileSize = await selector.boundingBox();
      assert.ok(mobileSize.width >= 250 && mobileSize.height >= 48);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({
        path: join(evidence, 'tag-selector-mobile.png'),
        fullPage: true,
      });
      await page.setViewportSize({ width: 1440, height: 1100 });
      await page.getByLabel('目标 tag').selectOption('v2.0.0');
      await page.getByRole('button', { name: '核对内部差异并选择这个版本 →' }).click();
      await page.getByRole('button', { name: '开始更新至 v2.0.0 →' }).click();
      await page.getByRole('button', { name: '保留文件、检查并推送候选 →' }).click();
      if (conflicting) {
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({
          path: join(evidence, 'version-preserved-mobile.png'),
          fullPage: true,
        });
        await page.setViewportSize({ width: 1440, height: 1100 });
      }
      const prStage = page.locator('[data-stage="3"]');
      if (!(await prStage.evaluate((node) => node.open))) await openStage(page, await prStage.getAttribute('data-stage'));
      await page.locator('[data-form="pr"]').waitFor({ timeout: 20000 });
      assert.equal(await page.locator('[data-form="issue"]').count(), 0);
      assert.equal(await page.locator('[data-form="receipts"]').count(), 0);
      await page.screenshot({
        path: join(evidence, conflicting ? 'version-resolved.png' : 'version-candidate.png'),
        fullPage: true,
      });
      await page.getByLabel('内部 PR 具体链接').fill('https://codehub.example/core/pull/501');
      await page.locator('[data-pr-confirm]').check();
      await page.getByRole('button', { name: '登记 PR，进入审核' }).click();
      await f.merge(
        (
          await (
            await configuredReceiver({
              ...f.config,
              mode: undefined,
              internalPaths: undefined,
              mergePaths: undefined,
            })
          ).status()
        ).active,
      );
      await page.getByRole('button', { name: '已在平台合入，核验 Git 结果' }).click();
      await page.getByRole('heading', { name: '当前已接收版本' }).waitFor({ timeout: 20000 });
      const receiver = await configuredReceiver({
        ...f.config,
        mode: undefined,
        internalPaths: undefined,
        mergePaths: undefined,
      });
      const state = await receiver.status();
      assert.equal(state.accepted.tag, 'v2.0.0');
      assert.equal(state.deliveries.length, 1);
      assert.equal(state.deliveries[0].status, 'COMPLETE');
      assert.deepEqual(state.issues, {});
      assert.deepEqual(errors, []);
      await page.screenshot({
        path: join(evidence, conflicting ? 'version-conflict-complete.png' : 'version-complete.png'),
        fullPage: true,
      });
      console.log(
        `PASS：${conflicting ? '内部追加定制、整文件保留、移动端' : '模式选择、严格核心规则与 tag 更新'} → 单 PR → 真实 Git 合入 → 版本记录；无 Issue 步骤。`,
      );
    } catch (error) {
      console.log(
        JSON.stringify({
          errors,
          body: (await page.locator('body').innerText()).slice(0, 4000),
        }),
      );
      throw error;
    } finally {
      console.log(`Cleanup version ${conflicting}: closing page`);
      await page.close();
      console.log(`Cleanup version ${conflicting}: closing server`);
      await new Promise((done) => server.close(done));
      console.log(`Cleanup version ${conflicting}: server closed`);
    }
  }
} finally {
  console.log('Cleanup version: closing browser');
  await closeBrowser();
  console.log('Cleanup version: browser closed');
}

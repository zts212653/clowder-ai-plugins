import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Receiver } from '../src/engine.mjs';
import { git } from '../src/process.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { configuredReceiver } from '../src/settings.mjs';
import { openStage } from './journey-controls.mjs';
import { launchOwnedBrowser } from './owned-browser.mjs';
import { activateBaseline } from './setup-journey-helpers.mjs';
import { versionRepositories } from './version-fixtures.mjs';

const { browser, close: closeBrowser } = await launchOwnedBrowser(chromium, {
  headless: true,
  executablePath: process.env.REPO_SYNC_CHROME,
});
const evidence = process.env.REPO_SYNC_EVIDENCE || join(tmpdir(), 'repo-sync-reliability-evidence');
await mkdir(evidence, { recursive: true });
async function serve(receiver, run) {
  const server = createReceiverServer(receiver);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
    await server.shutdown();
  }
}
try {
  const f = await versionRepositories();
  for (let index = 0; index < 250; index++) {
    const folder = join(f.source, 'bulk', `dir-${index}`);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'file.txt'), `upstream ${index}`);
  }
  await git(f.source, ['add', '.']);
  await git(f.source, ['commit', '-m', 'many release files']);
  await git(f.source, ['tag', 'v3.0.0']);
  const receiver = new Receiver({
    ...f.config,
    internalWebUrl: 'https://codehub.example/core',
  });
  await receiver.adopt(f.u0, f.i0);
  await receiver.selectTag('v3.0.0');
  await receiver.start();
  await serve(receiver, async (page) => {
    const reviewStage = page.locator('[data-stage="2"]');
    if (!(await reviewStage.evaluate((element) => element.open)))
      await openStage(page, await reviewStage.getAttribute('data-stage'));
    const tree = page.locator('[data-file-tree]').first();
    assert.equal(await tree.isVisible(), false);
    await page.getByText(/上游文件变化（/).click();
    assert.ok((await tree.locator('.file-row').count()) <= 50);
    await tree.getByLabel('搜索文件').fill('bulk/dir-249/');
    await tree.getByText('file.txt', { exact: true }).waitFor();
    assert.equal(await tree.locator('.file-row').count(), 1);
    await page.screenshot({ path: join(evidence, 'file-tree.png') });
    await page.getByRole('button', { name: '保留文件、检查并推送候选 →' }).click();
    const prStage = page.locator('[data-stage="3"]');
    if (!(await prStage.evaluate((element) => element.open)))
      await openStage(page, await prStage.getAttribute('data-stage'));
    await page.locator('[data-form="pr"]').waitFor({ timeout: 30000 });
    const candidate = (await receiver.status()).active.candidate;
    await page.getByLabel('内部 PR 具体链接').fill('https://elsewhere.example/core/pull/1');
    await page.locator('[data-pr-confirm]').check();
    await page.getByRole('button', { name: '登记 PR，进入审核' }).click();
    await page.locator('#error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#error').innerText(), /PR_URL_MISMATCH/);
    await page.getByLabel('内部 PR 具体链接').fill('https://codehub.example/core/pull/999');
    await page.locator('[data-pr-confirm]').check();
    await page.getByRole('button', { name: '登记 PR，进入审核' }).click();
    await page.getByRole('link', { name: '打开内部 PR ↗', exact: true }).waitFor({ timeout: 20000 });
    assert.equal(
      await page.getByRole('link', { name: '打开内部 PR ↗', exact: true }).getAttribute('href'),
      'https://codehub.example/core/pull/999',
    );
    if (!(await page.locator('[data-stage="3"]').evaluate((element) => element.open)))
      await openStage(page, 3);
    await page.getByText('链接填错了？纠正或撤销引用').click();
    await page.getByLabel('内部 PR 具体链接').fill('https://codehub.example/core/pull/501');
    await page.locator('[data-pr-confirm]').check();
    await page.getByRole('button', { name: '保存纠正后的 PR 链接' }).click();
    await page.locator('a.button[href="https://codehub.example/core/pull/501"]').waitFor({ timeout: 20000 });
    assert.equal((await receiver.status()).active.prUrl, 'https://codehub.example/core/pull/501');
    if (!(await page.locator('[data-stage="3"]').evaluate((element) => element.open)))
      await openStage(page, 3);
    await page.getByText('链接填错了？纠正或撤销引用').click();
    await page.locator('[data-form="clear-pr"] input[type="checkbox"]').check();
    await page.getByRole('button', { name: '撤销错误引用，返回 PR 创建步骤' }).click();
    await page.getByRole('button', { name: '登记 PR，进入审核' }).waitFor({ timeout: 20000 });
    assert.equal((await receiver.status()).active.candidate, candidate);
    await page.getByLabel('内部 PR 具体链接').fill('https://codehub.example/core/pull/501');
    await page.locator('[data-pr-confirm]').check();
    await page.getByRole('button', { name: '登记 PR，进入审核' }).click();
    await page.getByRole('link', { name: '打开内部 PR ↗', exact: true }).waitFor({ timeout: 20000 });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({
      path: join(evidence, 'pr-correction-mobile.png'),
      fullPage: true,
    });
    await f.merge((await receiver.status()).active);
    await page.getByRole('button', { name: '已在平台合入，核验 Git 结果' }).click();
    await page.getByRole('heading', { name: '当前已接收版本' }).waitFor({ timeout: 30000 });
  });
  const b = await versionRepositories();
  const initial = new Receiver({
    ...b.config,
    internalPaths: [],
    mergePaths: [],
  });
  await serve(initial, async (page) => {
    await page.getByRole('button', { name: '配置同步基线 →' }).click();
    await page.getByLabel('上次已经接收的外部版本').fill(b.u0);
    await page.getByLabel('内部当前接收位置').fill(b.i0);
    await page.getByRole('button', { name: '核验起点并查看文件 →' }).click();
    await page.getByRole('heading', { name: '× 文件差异待处理' }).waitFor({ timeout: 30000 });
    const tree = page.locator('[data-file-tree]').first();
    assert.equal(await tree.isVisible(), true);
    await tree.getByLabel('搜索文件').fill('README.md');
    await tree.getByRole('checkbox', { name: '保留内部 README.md', exact: true }).check();
    await tree.getByLabel('搜索文件').fill('OWNED.md');
    await tree.getByRole('checkbox', { name: '保留内部 OWNED.md', exact: true }).check();
    await tree.getByLabel('搜索文件').fill('guide.md');
    await tree
      .getByRole('checkbox', {
        name: '保留内部 internal-docs/guide.md',
        exact: true,
      })
      .check();
    await page.getByText('查看具体文件的两侧内容', { exact: true }).click();
    await page.locator('[data-baseline-path]').selectOption('README.md');
    await page.getByRole('button', { name: '查看两侧文件内容' }).click();
    await page.locator('#baseline-file-content').getByText('内部联系说明', { exact: false }).waitFor();
    assert.match(await page.getByLabel('内部保留文件 / 目录（每行一项）').inputValue(), /README.md/);
    await page.getByRole('button', { name: '应用选择并重新核验' }).click();
    await page.getByRole('button', { name: '继续确认启用 →' }).waitFor({ timeout: 30000 });
    await activateBaseline(
      page,
      await configuredReceiver({
        ...b.config,
        mode: undefined,
        internalPaths: undefined,
        mergePaths: undefined,
      }),
    );
  });
  console.log(
    'PASS: product file-tree/search/pagination, wrong PR rejection/correction/withdrawal, real Git merge, inline baseline differences/rule draft/content/recheck; desktop and mobile.',
  );
} finally {
  await closeBrowser();
}

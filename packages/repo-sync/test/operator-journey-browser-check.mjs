import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createConnection } from '../src/connections.mjs';
import { git } from '../src/process.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { gitPrFixture } from './git-pr-fixtures.mjs';
import { openHistory, openStage } from './journey-controls.mjs';
import { launchOwnedBrowser } from './owned-browser.mjs';

const f = await gitPrFixture(),
  folder = await mkdtemp(join(tmpdir(), 'repo-sync-operator-'));
Object.assign(process.env, {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: `url.${f.source.replaceAll('\\', '/')}.insteadOf`,
  GIT_CONFIG_VALUE_0: 'https://github.com/demo/core.git',
  GIT_CONFIG_KEY_1: `url.${f.internal.replaceAll('\\', '/')}.insteadOf`,
  GIT_CONFIG_VALUE_1: 'git@codehub.example:team/core.git',
});
const connection = await createConnection(join(folder, 'config.json'));
const server = createReceiverServer(null, { connection, syncInterval: 100 });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const { browser, close: closeBrowser } = await launchOwnedBrowser(chromium, {
  headless: true,
  executablePath: process.env.REPO_SYNC_CHROME,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const evidence = process.env.REPO_SYNC_EVIDENCE || join(folder, 'evidence');
await mkdir(evidence, { recursive: true });
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/?view=configuration`);
  await page.locator('[data-mode-cards]').waitFor();
  assert.equal(await page.locator('[name="mode"]:checked').count(), 0);
  await page.locator('[data-mode-card="continuous"]').click();
  await page.getByLabel('外部 GitHub 仓库地址').fill('https://github.com/invalid');
  await page.getByLabel('内部 Git 仓库地址').fill('git@codehub.example:team/core.git');
  assert.equal(await page.locator('[data-connection-auth]').evaluate((node) => node.open), false);
  await page.screenshot({ path: join(evidence, 'first-setup-addresses.png'), fullPage: true });
  await page.locator('[data-next-auth]').click();
  await page.locator('[name="githubToken"]').fill('SYNTHETIC_NOT_A_REAL_TOKEN');
  await page.getByRole('button', { name: '保存并检查连接 →', exact: true }).click();
  assert.equal(await page.locator('[name="sourceUrl"]').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('[name="githubToken"]').inputValue(), 'SYNTHETIC_NOT_A_REAL_TOKEN');
  assert.equal(await connection.current(), null);
  assert.ok(
    !(await page.evaluate(() => JSON.stringify({ ...sessionStorage }))).includes(
      'SYNTHETIC_NOT_A_REAL_TOKEN',
    ),
  );
  await page.locator('[data-mode-card="version"]').click();
  await page.getByLabel('外部 GitHub 仓库地址').fill('https://github.com/demo/core.git');
  await page.getByLabel('外部交付分支').fill('releases');
  await page.getByLabel('内部仓库网页地址（登记对象前必填）').fill('https://codehub.example/core');
  await page.getByLabel('PR 创建方式').selectOption('manual');
  await page.getByRole('button', { name: '保存并检查连接 →', exact: true }).click();
  await page.getByLabel('上次已经接收的外部版本').waitFor({ timeout: 30000 });
  assert.equal(await page.locator('[data-setup-repositories]').evaluate((node) => node.open), false);
  assert.equal(await page.getByLabel('内部当前接收位置').inputValue(), f.i0);
  await page.getByLabel('上次已经接收的外部版本').fill('v1.0.0');
  await page.getByRole('button', { name: '核验起点并查看文件 →' }).click();
  await page.locator('#baseline-differences [data-rule-choice="README.md"]').waitFor({ timeout: 30000 });
  assert.equal(await (await connection.current()).status(), null, 'inspection cannot adopt');
  await page.locator('#baseline-differences [data-file-filter]').selectOption('readme');
  assert.equal(await page.locator('#baseline-differences [data-rule-choice="core.txt"]').count(), 0);
  assert.equal(await page.locator('#baseline-differences [data-rule-choice="README.md"]').isChecked(), false);
  await page.locator('#baseline-differences [data-file-filter]').selectOption('all');
  for (const rule of ['README.md', 'OWNED.md', 'internal-docs/'])
    await page.locator(`[data-rule-choice="${rule}"]`).check();
  await page.getByRole('button', { name: '应用选择并重新核验' }).click();
  await page.locator('[data-confirm-baseline]').waitFor({ timeout: 30000 });
  assert.equal(await (await connection.current()).status(), null, 'rule recheck cannot adopt');
  await page.locator('[data-confirm-baseline]').click();
  await page.getByRole('button', { name: '启用并进入同步工作台 →' }).click();
  await page.getByRole('button', { name: '读取可用 tag', exact: true }).waitFor({ timeout: 30000 });
  // Seed the existing Git adapter for legacy compatibility; new UI deliberately offers API creation.
  await connection.run({
    action: 'configure-pr',
    expectedRevision: connection.describe().revision,
    prMode: 'git',
    internalWebUrl: 'https://codehub.example/core',
  });
  await page.reload();
  await page.getByRole('button', { name: '读取可用 tag', exact: true }).click();
  await page.locator('[name="tag"]').selectOption('v2.0.0');
  await page.locator('[data-preview-sync]').click();
  await page.locator('#sync-preview').waitFor({ timeout: 30000 });
  const receiver = await connection.current();
  assert.equal((await receiver.status()).queue.length, 0, 'preview cannot publish a queue');
  assert.equal((await receiver.status()).activeId, null);
  await page.getByRole('button', { name: '同步到所选版本 →' }).click();
  await page.getByRole('link', { name: '打开内部 PR ↗', exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.locator('.primary:visible').count(), 1);
  const active = (await receiver.status()).active;
  assert.ok(active.prUrl.endsWith('/501'));
  await openStage(page, 1);
  await openHistory(page);
  await page.locator('.record-list input[name="q"]').fill('v2');
  await page.locator('.record-list input[name="q"]').evaluate((element) => element.setSelectionRange(1, 1));
  await page.waitForTimeout(5500);
  assert.equal(await page.locator('.records-page').count(), 1);
  assert.equal(await page.evaluate(() => document.activeElement?.name), 'q');
  assert.equal(
    await page.locator('.record-list input[name="q"]').evaluate((element) => element.selectionStart),
    1,
  );
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({
      path: join(evidence, `operator-waiting-${width}.png`),
      fullPage: true,
    });
  }
  await f.merge(active);
  await page.getByRole('heading', { name: '当前已接收版本' }).waitFor({ timeout: 30000 });
  assert.equal((await receiver.status()).accepted.upstream, f.u1);
  assert.equal(await git(f.internal, ['show', 'main:README.md']), '介绍\n\n运行说明\n\n内部联系说明');
  const saved = await readFile(join(folder, 'config.json'), 'utf8');
  assert.ok(!saved.includes('SYNTHETIC_NOT_A_REAL_TOKEN'));
  assert.deepEqual(errors, []);
  console.log(
    'PASS: empty project → explicit mode → credential-safe validation → real Git checks → tag baseline → file-tree preservation → explicit activation → read-only preview → one-click PR → manual merge → automatic acceptance; focus and four viewport widths.',
  );
} catch (error) {
  console.error('Page errors:', errors, '\nVisible page:', await page.locator('body').innerText());
  await page.screenshot({
    path: join(evidence, 'operator-failure.png'),
    fullPage: true,
  });
  throw error;
} finally {
  await closeBrowser();
  await server.shutdown();
}

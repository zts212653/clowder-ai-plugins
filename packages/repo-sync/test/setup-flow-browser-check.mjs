import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createConnection } from '../src/connections.mjs';
import { phase } from '../src/execution.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { launchOwnedBrowser } from './owned-browser.mjs';
import { versionRepositories } from './version-fixtures.mjs';

const f = await versionRepositories(),
  folder = await mkdtemp(join(tmpdir(), 'repo-sync-setup-flow-'));
Object.assign(process.env, {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: `url.${f.source.replaceAll('\\', '/')}.insteadOf`,
  GIT_CONFIG_VALUE_0: 'https://github.com/demo/core.git',
  GIT_CONFIG_KEY_1: `url.${f.internal.replaceAll('\\', '/')}.insteadOf`,
  GIT_CONFIG_VALUE_1: 'git@codehub.example:team/core.git',
});
const connection = await createConnection(join(folder, 'config.json')),
  server = createReceiverServer(null, { connection });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const { browser, close: closeBrowser } = await launchOwnedBrowser(chromium, {
  headless: true,
  executablePath: process.env.REPO_SYNC_CHROME,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const evidence = process.env.REPO_SYNC_EVIDENCE || join(folder, 'evidence');
await mkdir(evidence, { recursive: true });
const visible = (selector) =>
  page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.top < innerHeight - 80;
  });
let releaseHeads = () => {};
async function holdNextHeads() {
  releaseHeads();
  // Saving the connection replaces its Receiver. Probe the currently bound one each time.
  const current = await connection.current(),
    original = current.git.heads.bind(current.git);
  const gate = new Promise((release) => {
    releaseHeads = release;
  });
  current.git.heads = async () => {
    current.git.heads = original;
    // Keep the genuine task running until the browser has measured progress and visibility.
    await phase('test-probe-wait', '等待独立测试仓连接', () => gate);
    return original();
  };
}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/?view=configuration`);
  await page.locator('[data-mode-card="version"]').check();
  await page.getByLabel('外部 GitHub 仓库地址').fill('https://github.com/demo/core.git');
  await page.getByLabel('内部 Git 仓库地址').fill('git@codehub.example:team/core.git');
  await page.getByLabel('内部仓库网页地址（登记对象前必填）').fill('https://codehub.example/core');
  await page.getByLabel('外部交付分支').fill('releases');
  if (!(await page.locator('[data-connection-auth]').evaluate((node) => node.open)))
    await page.locator('[data-connection-auth] > summary').click();
  await page.getByLabel('PR 创建方式', { exact: true }).selectOption('manual');
  await page.locator('[data-policy] > summary').click();
  await page.getByText('手动填写路径（高级）', { exact: true }).click();
  await page.getByLabel('内部保留文件 / 目录（每行一项）').fill('README.md\nOWNED.md\ninternal-docs/');
  await page.getByRole('button', { name: '保存并检查连接 →' }).click();
  await page.locator('form[data-form="configure-repositories"]').waitFor({ state: 'hidden' });
  assert.equal(
    await page.evaluate(() => document.activeElement?.name),
    'upstream',
    'Continue must focus the baseline step',
  );
  assert.equal(await page.locator('[data-setup-repositories]').evaluate((element) => element.open), false);
  assert.equal(await page.locator('#platform-settings').isVisible(), false);
  assert.ok(await visible('#upstream'));
  await page.screenshot({
    path: join(evidence, 'setup-current-baseline-desktop.png'),
    fullPage: false,
  });
  const receiver = await connection.current();
  await page.getByLabel('上次已经接收的外部版本').fill(f.u0);
  await holdNextHeads();
  try {
    await page.getByRole('button', { name: '读取两侧当前版本' }).click();
    await page.locator('#operation [data-operation-state="RUNNING"]').waitFor();
    assert.ok(await page.locator('#baseline-step #operation').count());
    assert.ok(await visible('#operation'));
  } finally {
    releaseHeads();
  }
  await page
    .locator('#observed-heads')
    .getByText(/读取成功/)
    .waitFor({ timeout: 20000 });
  assert.equal(await page.getByLabel('上次已经接收的外部版本').inputValue(), f.u0);
  assert.equal(await page.getByLabel('内部当前接收位置').inputValue(), f.i0);
  assert.equal(
    await page.evaluate(() => document.activeElement?.name),
    'internal',
    'read result must return to the next baseline input',
  );
  assert.ok(await visible('#internal'));
  await page.getByText('✓ 1 · 仓库信息已保存', { exact: true }).click();
  await page.getByText('修改连接信息', { exact: true }).click();
  await page.getByRole('button', { name: '保存并检查连接 →' }).click();
  await page.locator('form[data-form="configure-repositories"]').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('[data-setup-repositories]').evaluate((element) => element.open), false);
  assert.equal(await page.getByLabel('上次已经接收的外部版本').inputValue(), f.u0);
  await page.reload();
  await page.getByLabel('内部当前接收位置').waitFor();
  assert.equal(await page.locator('[data-setup-repositories]').evaluate((element) => element.open), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await holdNextHeads();
  try {
    await page.getByRole('button', { name: '读取两侧当前版本' }).click();
    await page.locator('#operation [data-operation-state="RUNNING"]').waitFor();
    assert.ok(await visible('#operation'));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: join(evidence, 'setup-progress-mobile.png'), fullPage: false });
  } finally {
    releaseHeads();
  }
  await page
    .locator('#observed-heads')
    .getByText(/读取成功/)
    .waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: '核验起点并查看文件 →' }).click();
  await page.getByRole('button', { name: '继续确认启用 →' }).waitFor({ timeout: 30000 });
  assert.ok(await visible('[data-confirm-baseline]'));
  assert.equal(await receiver.status(), null, 'inspection stays read-only');
  await page.getByRole('button', { name: '继续确认启用 →' }).click();
  assert.ok(await visible('form[data-form="adopt"] .primary'));
  assert.equal(await receiver.status(), null, 'confirmation still requires explicit activation');
  await page.getByRole('button', { name: '启用并进入同步工作台 →' }).click();
  await page.getByRole('button', { name: '读取可用 tag', exact: true }).waitFor({ timeout: 30000 });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: saved repositories collapse, baseline focus and viewport, inline progress, draft-safe edit/reload, desktop/mobile and real Git adoption.',
  );
} catch (error) {
  await writeFile(join(evidence, 'setup-flow-failure.txt'), await page.locator('body').innerText());
  await page.screenshot({ path: join(evidence, 'setup-flow-failure.png'), fullPage: true });
  console.error(JSON.stringify({ evidence, pageErrors: errors, error: error.message }));
  throw error;
} finally {
  releaseHeads();
  await closeBrowser();
  await server.shutdown();
}

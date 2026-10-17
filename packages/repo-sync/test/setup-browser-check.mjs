import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createConnection } from '../src/connections.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { openStage } from './journey-controls.mjs';
import { launchOwnedBrowser } from './owned-browser.mjs';
import { activateBaseline } from './setup-journey-helpers.mjs';
import { versionRepositories } from './version-fixtures.mjs';

const f = await versionRepositories();
const folder = await mkdtemp(join(tmpdir(), 'repo-sync-real-setup-'));
const file = join(folder, 'config.json');
const evidence = process.env.REPO_SYNC_EVIDENCE || join(tmpdir(), 'repo-sync-setup-evidence');
await mkdir(evidence, { recursive: true });
const external = 'https://github.com/demo/core.git';
const internal = 'git@codehub.example:team/core.git';
// Git's process-local URL rewrite keeps this real, non-demo server on isolated test repositories.
const environment = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: `url.${f.source.replaceAll('\\', '/')}.insteadOf`,
  GIT_CONFIG_VALUE_0: external,
  GIT_CONFIG_KEY_1: `url.${f.internal.replaceAll('\\', '/')}.insteadOf`,
  GIT_CONFIG_VALUE_1: internal,
};
const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
Object.assign(process.env, environment);
const connection = await createConnection(file);
const server = createReceiverServer(null, { connection });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const { browser, close: closeBrowser } = await launchOwnedBrowser(chromium, {
  headless: true,
  ...(process.env.REPO_SYNC_CHROME ? { executablePath: process.env.REPO_SYNC_CHROME } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(base);
  await page.getByRole('heading', { name: '开始同步你的项目' }).waitFor();
  await assert.rejects(access(file), { code: 'ENOENT' });
  assert.equal(await page.locator('.demo-links').count(), 0);
  await page.screenshot({
    path: join(evidence, 'real-first-use.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: '配置真实仓库 →' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(
    await page
      .locator('.flow.setup')
      .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length),
    1,
  );
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('[data-mode-card="continuous"]').check();
  assert.equal(await page.locator('[name="commitClosureVerified"]').count(), 1);
  await page.locator('[data-connection-auth] > summary').click();
  assert.ok(await page.getByLabel('Issue 创建与关单方式').isVisible());
  await page.locator('[data-mode-card="version"]').check();
  assert.equal(await page.getByLabel('外部 GitHub 仓库地址').inputValue(), '');
  assert.equal(await page.getByLabel('内部 Git 仓库地址').inputValue(), '');
  await page.getByLabel('外部 GitHub 仓库地址').fill('https://user:secret@github.com/demo/core.git');
  await page.getByLabel('内部 Git 仓库地址').fill(internal);
  await page.getByLabel('PR 创建方式', { exact: true }).selectOption('manual');
  await page.getByLabel('内部仓库网页地址（登记对象前必填）').fill('https://codehub.example/core');
  await page.getByLabel('外部交付分支').fill('releases');
  await page.locator('[data-policy] > summary').click();
  await page.getByText('手动填写路径（高级）', { exact: true }).click();
  await page.getByLabel('内部保留文件 / 目录（每行一项）').fill('internal-docs/\nOWNED.md\nREADME.md');
  assert.equal(await page.locator('[name="mergePaths"]').count(), 0);
  await page.getByRole('button', { name: '保存并检查连接 →' }).click();
  await page.locator('[data-field-error="sourceUrl"]').waitFor();
  assert.equal(await page.getByLabel('内部 Git 仓库地址').inputValue(), internal, 'error preserves draft');
  await page.getByLabel('外部 GitHub 仓库地址').fill(external);
  await page.screenshot({
    path: join(evidence, 'real-repository-settings.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: '保存并检查连接 →' }).click();
  await page.getByRole('heading', { name: '2 · 核验已有同步起点' }).waitFor({ timeout: 30000 });
  assert.equal(await page.getByLabel('上次已经接收的外部版本').inputValue(), '');
  await page.getByLabel('上次已经接收的外部版本').fill(f.u0);
  await page.getByRole('button', { name: '读取两侧当前版本' }).click();
  await page.locator('#observed-heads').filter({ hasText: '读取成功' }).waitFor({ timeout: 20000 });
  assert.equal(await page.getByLabel('内部当前接收位置').inputValue(), f.i0);
  assert.equal(
    await page.getByLabel('上次已经接收的外部版本').inputValue(),
    f.u0,
    'reading current heads preserves the chosen prior U0',
  );
  await page.getByLabel('上次已经接收的外部版本').fill(f.u0);
  await page.getByRole('button', { name: '核验起点并查看文件 →' }).click();
  await page.getByRole('button', { name: '继续确认启用 →' }).waitFor({ timeout: 30000 });
  await activateBaseline(page, await connection.current());
  assert.equal((await connection.current()).config.checkProfile, 'git-integrity');
  const status = await (await fetch(`${base}/api/status`)).json();
  const rejectEdit = await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'X-Repo-Sync-Token': status.token },
    body: JSON.stringify({
      action: 'configure-repositories',
      expectedRevision: status.connection.revision,
    }),
  });
  assert.equal((await rejectEdit.json()).code, 'CONFIGURATION_READ_ONLY');
  await page.getByRole('button', { name: '读取可用 tag' }).click();
  await page.getByLabel('目标 tag').selectOption('v2.0.0');
  await page.getByRole('button', { name: '核对内部差异并选择这个版本 →' }).click();
  await page.getByRole('button', { name: '开始更新至 v2.0.0 →' }).click();
  await page.getByRole('button', { name: '保留文件、检查并推送候选 →' }).waitFor();
  await page.getByRole('button', { name: '保留文件、检查并推送候选 →' }).click();
  const prStage = page.locator('[data-stage="3"]');
  if (!(await prStage.evaluate((node) => node.open)))
    await openStage(page, await prStage.getAttribute('data-stage'));
  await page.locator('[data-form="pr"]').waitFor({ timeout: 20000 });
  const prepared = (await (await connection.current()).status()).active;
  assert.equal(prepared.checks.profile, 'git-integrity');
  assert.equal(
    prepared.checks.passed,
    true,
    'the configured integrity check must actually pass before the PR step',
  );
  await page.getByLabel('内部 PR 具体链接').fill('https://codehub.example/core/pull/501');
  await page.locator('[data-pr-confirm]').check();
  await page.getByRole('button', { name: '登记 PR，进入审核' }).click();
  await page.getByRole('button', { name: '已在平台合入，核验 Git 结果' }).waitFor();
  assert.equal(
    await page.getByRole('link', { name: '打开内部 PR ↗', exact: true }).getAttribute('href'),
    'https://codehub.example/core/pull/501',
  );
  assert.equal((await fetch(`${base}/demo/pr/${'a'.repeat(24)}`)).status, 404);
  await f.merge((await (await connection.current()).status()).active);
  await page.getByRole('button', { name: '已在平台合入，核验 Git 结果' }).click();
  await page.getByRole('heading', { name: '当前已接收版本' }).waitFor({ timeout: 20000 });
  const restarted = await createConnection(file);
  assert.equal((await (await restarted.current()).status()).accepted.tag, 'v2.0.0');
  assert.equal(restarted.describe().editable, false);
  assert.equal(await readFile(join(f.review, 'README.md'), 'utf8'), '介绍\n\n运行说明\n\n内部联系说明\n');
  assert.equal(await readFile(join(f.review, 'internal-docs', 'guide.md'), 'utf8'), '内部独立说明\n');
  await page.reload();
  await page.getByRole('heading', { name: '当前已接收版本' }).waitFor();
  assert.deepEqual(errors, []);
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  console.log(
    'PASS：空配置 → 保存真实连接 → Git 读取 → U0/I0 → tag 更新 → 真实候选推送 → 平台 PR 链接 → Git 合入核验 → 重启续接；无模拟平台路由。',
  );
} finally {
  await closeBrowser();
  await new Promise((done) => server.close(done));
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

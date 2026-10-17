import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { git } from '../src/process.mjs';
import { createProjectWorkspace } from '../src/projects.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { repositories } from './fixtures.mjs';
import { openStage } from './journey-controls.mjs';
import { launchOwnedBrowser } from './owned-browser.mjs';
import { inspectAndActivate } from './setup-journey-helpers.mjs';

const a = await repositories(),
  b = await repositories(),
  folder = await mkdtemp(join(tmpdir(), 'repo-sync-project-ui-'));
const file = join(folder, 'config.json');
await writeFile(file, JSON.stringify(a.config, null, 2));
await git(b.source, ['tag', 'v2.0.0', b.u2]);
const env = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: `url.${b.source.replaceAll('\\', '/')}.insteadOf`,
  GIT_CONFIG_VALUE_0: 'https://github.com/demo/other.git',
  GIT_CONFIG_KEY_1: `url.${b.internal.replaceAll('\\', '/')}.insteadOf`,
  GIT_CONFIG_VALUE_1: 'git@internal.example:team/other.git',
};
Object.assign(process.env, env);
const projects = await createProjectWorkspace(file),
  ca = await projects.connection(),
  ra = await ca.current();
await ra.adopt(a.u0, a.i0);
const ledgerBefore = await readFile(ra.store.path, 'utf8');
let release;
const gate = new Promise((done) => {
  release = done;
});
const originalHeads = ra.git.heads.bind(ra.git);
ra.git.heads = async () => {
  await gate;
  return originalHeads();
};
const server = createReceiverServer(null, { projects });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`,
  { browser, close: closeBrowser } = await launchOwnedBrowser(chromium, {
    headless: true,
    executablePath: process.env.REPO_SYNC_CHROME,
  });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }),
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const evidence = process.env.REPO_SYNC_EVIDENCE || join(folder, 'evidence');
await mkdir(evidence, { recursive: true });
try {
  await page.goto(base);
  await page.locator('.project-sidebar-row.selected').waitFor();
  await page.getByRole('button', { name: '仓库设置', exact: true }).click();
  await page.getByLabel('项目名称', { exact: true }).fill('过程同步项目');
  await page.getByRole('button', { name: '保存设置并验证 →', exact: true }).click();
  await page.locator('.project-sidebar-row').filter({ hasText: '过程同步项目' }).waitFor();
  (await ca.current()).git.heads = ra.git.heads;
  const renamedConfig = await readFile(file, 'utf8');
  await page.getByRole('button', { name: '同步工作台', exact: true }).click();
  const initial = await (await fetch(`${base}/api/status`)).json();
  await fetch(`${base}/api/tasks?project=default`, {
    method: 'POST',
    headers: { 'X-Repo-Sync-Token': initial.token },
    body: JSON.stringify({
      action: 'heads',
      projectId: 'default',
      requestId: 'a'.repeat(32),
      expectedBinding: ra.config.bindingId,
    }),
  });
  await page.reload();
  assert.equal(await page.getByLabel('当前同步项目').isEnabled(), true);
  await page.getByRole('button', { name: '＋ 新增项目', exact: true }).click();
  await page.getByLabel('项目名称', { exact: true }).fill('版本同步项目');
  await page.getByRole('button', { name: '创建项目，配置仓库 →', exact: true }).click();
  await page.getByLabel('外部 GitHub 仓库地址').waitFor();
  const id = new URL(page.url()).searchParams.get('project');
  assert.ok(id && id !== 'default');
  await page.getByLabel('外部 GitHub 仓库地址').fill('https://github.com/demo/other.git');
  await page.getByLabel('内部 Git 仓库地址', { exact: true }).fill('git@internal.example:team/other.git');
  await page.getByLabel('内部仓库网页地址（登记对象前必填）').fill('https://internal.example/other');
  if (!(await page.locator('[data-connection-auth]').evaluate((node) => node.open)))
    await page.locator('[data-connection-auth] > summary').click();
  await page.getByLabel('PR 创建方式', { exact: true }).selectOption('manual');
  await page.locator('[data-mode-card="version"]').check();
  await page.locator('[data-policy] > summary').click();
  await page.getByText('手动填写路径（高级）', { exact: true }).click();
  await page.getByLabel('内部保留文件 / 目录（每行一项）').fill('README.md');
  await page.getByRole('button', { name: '过程同步项目的仓库设置', exact: true }).click();
  await page.getByRole('heading', { name: '项目设置', exact: true }).waitFor();
  await page.getByRole('button', { name: '版本同步项目的仓库设置', exact: true }).click();
  await page.getByLabel('外部 GitHub 仓库地址').waitFor();
  assert.equal(
    await page.getByLabel('外部 GitHub 仓库地址').inputValue(),
    'https://github.com/demo/other.git',
  );
  assert.equal(await page.getByLabel('内部保留文件 / 目录（每行一项）').inputValue(), 'README.md');
  await page.getByRole('button', { name: '保存并检查连接 →' }).click();
  await page.getByRole('heading', { name: '2 · 核验已有同步起点' }).waitFor({ timeout: 30000 });
  await page.locator('#internal').fill(b.i0);
  await page.locator('#upstream').fill(b.u0);
  await inspectAndActivate(page, b.u0, b.i0, await (await projects.connection(id)).current());
  await page.getByRole('button', { name: '读取可用 tag', exact: true }).click();
  await page.locator('[name="tag"]').selectOption('v2.0.0');
  await page.getByRole('button', { name: '核对内部差异并选择这个版本 →' }).click();
  await page.getByRole('button', { name: '开始更新至 v2.0.0 →' }).click();
  await page.getByRole('button', { name: '保留文件、检查并推送候选 →' }).click();
  const cb = await projects.connection(id),
    rb = await cb.current();
  const prStage = page.locator('[data-stage="3"]');
  if (!(await prStage.evaluate((node) => node.open)))
    await openStage(page, await prStage.getAttribute('data-stage'));
  await page.locator('[data-form="pr"]').waitFor({ timeout: 30000 });
  await rb.linkPr('https://internal.example/other/pull/1');
  await page.reload();
  await b.merge((await rb.status()).active);
  await page.getByRole('button', { name: '已在平台合入，核验 Git 结果' }).click();
  await page.getByRole('heading', { name: '当前已接收版本', exact: true }).waitFor({ timeout: 30000 });
  const completed = (await rb.status()).deliveries[0];
  const otherTab = await browser.newPage();
  await otherTab.goto(`${base}/?project=default`);
  await otherTab.locator('.project-sidebar-row.selected').waitFor();
  assert.equal(await otherTab.getByLabel('当前同步项目').inputValue(), 'default');
  assert.equal(await page.getByLabel('当前同步项目').inputValue(), id);
  await otherTab.close();
  await page.locator('.history-disclosure > summary').click();
  await page.locator(`.history-disclosure [data-record="${completed.id}"]`).click();
  await page.getByText('历史记录 · 只读', { exact: true }).waitFor();
  await page.locator('.delivery-boundary > summary').click();
  assert.ok((await page.locator('.record-detail').innerText()).includes(b.u2));
  await page.locator('.project-sidebar-list [data-project-enter="default"]').click();
  await page.getByRole('heading', { name: '原操作需要处理', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.has('record'), false);
  assert.equal(await page.locator(`.history-disclosure [data-record="${completed.id}"]`).count(), 0);
  assert.equal((await ra.status()).accepted.upstream, a.u0);
  release();
  for (let count = 0; count < 100; count++) {
    const task = (await (await fetch(`${base}/api/status?project=default`)).json()).operation;
    if (task.status === 'SUCCEEDED') break;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.equal(await readFile(file, 'utf8'), renamedConfig);
  assert.equal(await readFile(ra.store.path, 'utf8'), ledgerBefore);
  await page.locator(`.project-sidebar-list [data-project-enter="${id}"]`).click();
  await page.getByRole('heading', { name: '当前已接收版本', exact: true }).waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({
      path: join(evidence, `projects-${width}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1440, height: 1050 });
  let lost = false;
  await page.route('**/api/projects', async (route) => {
    if (
      route.request().method() === 'POST' &&
      !lost &&
      JSON.parse(route.request().postData()).action === 'create'
    ) {
      lost = true;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole('button', { name: '＋ 新增项目', exact: true }).click();
  await page.getByLabel('项目名称', { exact: true }).fill('回执恢复项目');
  await page.getByRole('button', { name: '创建项目，配置仓库 →', exact: true }).click();
  await page.getByRole('button', { name: '查询 / 重试原新增请求', exact: true }).click();
  await page.getByLabel('外部 GitHub 仓库地址').waitFor();
  assert.equal((await projects.list()).projects.length, 3);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: one portal creates/selects two modes, A continues in background while B completes real Git/PR reception, original bytes preserved, history isolated, lost project receipt reused, desktop/mobile.',
  );
} catch (error) {
  console.error(await page.locator('body').innerText());
  throw error;
} finally {
  release();
  await closeBrowser();
  await server.shutdown();
}

import { launchOwnedBrowser } from './owned-browser.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { git } from '../src/process.mjs';
import { createProjectWorkspace } from '../src/projects.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { activateBaseline } from './setup-journey-helpers.mjs';
import { versionRepositories } from './version-fixtures.mjs';

const f = await versionRepositories(),
  folder = await mkdtemp(join(tmpdir(), 'repo-sync-tree-'));
for (let i = 0; i < 65; i++)
  await writeFile(join(f.review, 'internal-docs', `file-${String(i).padStart(3, '0')}.md`), `internal ${i}`);
await git(f.review, ['add', '.']);
await git(f.review, ['commit', '-m', 'synthetic internal documentation']);
await git(f.review, ['push', 'origin', 'main']);
const i0 = await git(f.review, ['rev-parse', 'HEAD']),
  file = join(folder, 'config.json');
Object.assign(process.env, {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: `url.${f.source.replaceAll('\\', '/')}.insteadOf`,
  GIT_CONFIG_VALUE_0: 'https://github.com/demo/core.git',
  GIT_CONFIG_KEY_1: `url.${f.internal.replaceAll('\\', '/')}.insteadOf`,
  GIT_CONFIG_VALUE_1: 'git@codehub.example:team/core.git',
});
await writeFile(
  file,
  JSON.stringify({
    ...f.config,
    sourceUrl: 'https://github.com/demo/core.git',
    internalUrl: 'git@codehub.example:team/core.git',
    configurationSource: 'workbench',
    internalPaths: ['unlisted-private/'],
  }),
);
const projects = await createProjectWorkspace(file),
  server = createReceiverServer(null, { projects });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const { browser, close: closeBrowser } = await launchOwnedBrowser(chromium, {
  headless: true,
  executablePath: process.env.REPO_SYNC_CHROME,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }),
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const evidence = process.env.REPO_SYNC_EVIDENCE || join(folder, 'evidence');
await mkdir(evidence, { recursive: true });
const checkbox = (path) => page.getByRole('checkbox', { name: `保留内部 ${path}`, exact: true });
try {
  await page.goto(`${base}/?view=configuration`);
  await page.getByLabel('上次已经接收的外部版本').fill(f.u0);
  await page.getByLabel('内部当前接收位置').fill(i0);
  await page.getByRole('button', { name: '核验起点并查看文件 →' }).click();
  const panel = page.locator('#baseline-differences'),
    tree = panel.locator('[data-file-tree]');
  await panel.waitFor({ timeout: 30000 });
  assert.equal(await page.locator('[name="internalPaths"]').isVisible(), false);
  await checkbox('README.md').check();
  await tree.getByLabel('搜索文件').fill('internal-docs/file-003');
  await checkbox('internal-docs/file-003.md').check();
  assert.equal(await checkbox('internal-docs/').evaluate((node) => node.indeterminate), true);
  await checkbox('internal-docs/').check();
  assert.equal(await checkbox('internal-docs/file-003.md').isDisabled(), true);
  assert.equal(await checkbox('internal-docs/file-003.md').isChecked(), true);
  await tree.getByLabel('搜索文件').fill('');
  await tree.getByRole('button', { name: '下一页' }).click();
  assert.match(await tree.locator('[data-tree-count]').textContent(), /第 2 \/ 2 页/);
  assert.equal(await checkbox('internal-docs/file-064.md').isChecked(), true);
  await page.reload();
  await panel.waitFor();
  assert.match(await panel.locator('[data-selected-rules]').textContent(), /README.md/);
  assert.match(await panel.locator('[data-selected-rules]').textContent(), /unlisted-private\//);
  await tree.getByLabel('搜索文件').fill('internal-docs/file-003');
  await panel.getByRole('button', { name: '取消保留 internal-docs/', exact: true }).click();
  assert.equal(await checkbox('internal-docs/file-003.md').isChecked(), false);
  await checkbox('internal-docs/').check();
  const unchanged = await readFile(file, 'utf8');
  await page.getByText('✓ 1 · 仓库信息已保存', { exact: true }).click();
  await page.getByText('修改连接信息', { exact: true }).click();
  await page.getByLabel('内部合入分支', { exact: true }).fill('other');
  assert.equal(await panel.count(), 0, 'editing connection invalidates the old baseline report');
  assert.equal(await page.getByRole('button', { name: '应用选择并重新核验' }).count(), 0);
  assert.equal(await readFile(file, 'utf8'), unchanged);
  await page.getByLabel('内部合入分支', { exact: true }).fill('main');
  await page.getByRole('button', { name: '保存并检查连接 →', exact: true }).click();
  await page.getByRole('heading', { name: '2 · 核验已有同步起点' }).waitFor({ timeout: 30000 });
  await page.locator('#upstream').fill(f.u0);
  await page.locator('#internal').fill(i0);
  await page.getByRole('button', { name: '核验起点并查看文件 →', exact: true }).click();
  await panel.waitFor({ timeout: 30000 });
  await tree.getByLabel('搜索文件').fill('');
  await page.screenshot({
    path: join(evidence, 'file-rule-selection-desktop.png'),
    fullPage: true,
  });
  await panel.screenshot({
    path: join(evidence, 'file-rule-panel-desktop.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({
    path: join(evidence, 'file-rule-selection-mobile.png'),
    fullPage: true,
  });
  await panel.screenshot({
    path: join(evidence, 'file-rule-panel-mobile.png'),
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await panel.getByRole('button', { name: '应用选择并重新核验' }).click();
  await panel
    .locator('[data-rule-feedback]')
    .getByText(/规则已保存，基线未通过/)
    .waitFor({ timeout: 30000 });
  const connection = await projects.connection(),
    receiver = await connection.current();
  assert.equal(await receiver.status(), null);
  assert.deepEqual(receiver.config.internalPaths, ['README.md', 'internal-docs/', 'unlisted-private/']);
  assert.equal(await git(f.internal, ['rev-parse', 'main']), i0);
  assert.equal(await checkbox('OWNED.md').isChecked(), false);
  await checkbox('OWNED.md').check();
  await panel.getByRole('button', { name: '应用选择并重新核验' }).click();
  await page
    .getByText('所选内部保留规则已保存，核心文件核验通过；尚未启用。下一步：继续确认启用。', { exact: true })
    .waitFor({ timeout: 30000 });
  const final = await connection.current();
  assert.equal(await final.status(), null, 'file-rule recheck must not register the baseline');
  await activateBaseline(page, final);
  assert.equal((await final.status()).accepted.upstream, f.u0);
  assert.equal((await final.status()).accepted.internal, i0);
  assert.equal(await page.locator('[data-rule-choice]').count(), 0);
  const original = await readFile(file, 'utf8');
  await assert.rejects(
    () =>
      connection.run({
        action: 'configure-file-rules',
        expectedRevision: connection.describe().revision,
        expectedBinding: final.config.bindingId,
        internalPaths: ['core.txt'],
      }),
    { code: 'CONFIGURATION_READ_ONLY' },
  );
  assert.equal(await readFile(file, 'utf8'), original);
  await final.selectTag('v2.0.0');
  await final.start();
  await final.prepare();
  const delivery = (await final.status()).active;
  const candidateReadme = await git(final.git.directory, ['show', `${delivery.candidate}:README.md`]);
  assert.match(candidateReadme, /内部联系说明/);
  assert.equal(await git(final.git.directory, ['show', `${delivery.candidate}:core.txt`]), 'release two');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: managed project file/directory choices, inherited and partial states, >50 paths, unseen rules, refresh, draft guard, save/recheck failure and recovery, locked rules, exact Git preservation and core update; desktop/mobile.',
  );
} finally {
  await page.close();
  await closeBrowser();
  await server.shutdown();
}

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createProjectWorkspace } from '../src/projects.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { launchOwnedBrowser } from './owned-browser.mjs';

// Genuine production HTTP routes, registry, private files, assets and app entry.
// HTTPS example repositories are intentionally never fetched in this template-only journey.
const sourceFolder = await mkdtemp(join(tmpdir(), 'repo-sync-template-source-'));
const targetFolder = await mkdtemp(join(tmpdir(), 'repo-sync-template-target-'));
const sourceProjects = await createProjectWorkspace(join(sourceFolder, 'config.json'));
const targetFile = join(targetFolder, 'config.json');
const sourceConnection = await sourceProjects.connection();
await sourceConnection.run({
  action: 'configure-repositories',
  expectedRevision: null,
  mode: 'version',
  sourceUrl: 'https://github.com/demo/core.git',
  internalUrl: 'git@internal.example:team/core.git',
  sourceBranch: 'main',
  targetBranch: 'main',
  internalWebUrl: 'https://internal.example/team/core',
  internalPaths: ['README.md'],
  mergePaths: [],
  prMode: 'manual',
  commitClosureVerified: false,
});
const source = createReceiverServer(null, { projects: sourceProjects, syncInterval: 60000 });
let target = createReceiverServer(null, { projects: await createProjectWorkspace(targetFile), syncInterval: 60000 });
await new Promise((done) => source.listen(0, '127.0.0.1', done));
await new Promise((done) => target.listen(0, '127.0.0.1', done));
const sourceUrl = `http://127.0.0.1:${source.address().port}`;
const targetPort = target.address().port;
const targetUrl = `http://127.0.0.1:${targetPort}`;
const owner = await launchOwnedBrowser(chromium, { headless: true, executablePath: process.env.REPO_SYNC_CHROME });
const page = await owner.browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors = [],
  taskWrites = [];
page.setDefaultTimeout(15000);
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => {
  if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks') taskWrites.push(request.url());
});
try {
  await page.goto(`${sourceUrl}/?view=configuration`);
  await page.getByText('导入 / 导出配置与同步进度', { exact: true }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出无凭据配置模板', exact: true }).click();
  const download = await downloading,
    artifact = join(sourceFolder, 'downloaded-template.json');
  await download.saveAs(artifact);
  const pkg = JSON.parse(await readFile(artifact, 'utf8'));
  assert.equal(pkg.kind, 'template');
  assert.equal(pkg.config.stateDir, undefined);
  assert.equal(pkg.config.sourceUrl, 'https://github.com/demo/core.git');
  assert.equal((await sourceConnection.current()).config.sourceUrl, pkg.config.sourceUrl);
  await page.goto(`${targetUrl}/?view=configuration`);
  await page.getByText('导入 / 导出配置与同步进度', { exact: true }).click();
  await page.getByLabel('选择配置模板或完整迁移包').setInputFiles(artifact);
  await page.getByRole('button', { name: '读取并检查文件', exact: true }).click();
  await page.getByRole('heading', { name: '无凭据配置模板 · 文件已校验', exact: true }).waitFor();
  await page.getByText('历史 0 笔 · 执行记录 0 条 · Issue 映射 0 个', { exact: true }).waitFor();
  const before = await (await fetch(`${targetUrl}/api/projects`)).json();
  assert.equal(before.workspace.projects.length, 1, 'preview must not create a project');
  await page.getByLabel('导入后的项目名称').fill('模板接收项目');
  await page.getByRole('button', { name: '导入为独立项目', exact: true }).click();
  await page.waitForURL((url) => /^[a-f0-9]{24}$/.test(url.searchParams.get('project') ?? ''));
  await page.getByRole('heading', { name: '完成迁移前核验', exact: true }).waitFor();
  assert.equal(await page.locator('.transfer-metadata').evaluate((element) => element.open), false);
  assert.equal(
    await page
      .locator('[data-transfer-check]')
      .evaluate((element) => element.getBoundingClientRect().bottom < innerHeight),
    true,
    'next check action must be in the first viewport',
  );
  const projectId = new URL(page.url()).searchParams.get('project');
  const current = await (await fetch(`${targetUrl}/api/status?project=${projectId}`)).json();
  assert.equal(current.transfer.status, 'IMPORTED');
  assert.equal(current.transfer.packageId, pkg.packageId);
  assert.equal(
    current.config.bindingId,
    sourceConnection.describe().bindingId ?? (await sourceConnection.current()).config.bindingId,
  );
  assert.equal(current.state, null, 'template never invents a new baseline or history');
  assert.equal(current.operation, null, 'import must not start any delivery');
  assert.notEqual(current.connection.stateDir, sourceConnection.describe().stateDir);
  assert.equal(
    await page.locator('[data-form="inspect-baseline"]').count(),
    0,
    'held import cannot bypass migration checks via ordinary setup',
  );
  assert.equal(await page.getByRole('button', { name: '确认启用此环境', exact: true }).isEnabled(), false);
  await page.reload();
  await page.getByRole('heading', { name: '完成迁移前核验', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('project'), projectId);
  await target.shutdown();
  const reopenedProjects = await createProjectWorkspace(targetFile);
  target = createReceiverServer(null, { projects: reopenedProjects, syncInterval: 60000 });
  await new Promise((done) => target.listen(targetPort, '127.0.0.1', done));
  await page.reload();
  await page.getByRole('heading', { name: '完成迁移前核验', exact: true }).waitFor();
  const reopened = await (await fetch(`${targetUrl}/api/status?project=${projectId}`)).json();
  assert.equal(reopened.transfer.status, 'IMPORTED');
  assert.equal(reopened.transfer.packageId, pkg.packageId);
  assert.equal(reopened.config.bindingId, current.config.bindingId);
  assert.equal(reopened.connection.stateDir, current.connection.stateDir);
  assert.equal(reopened.state, null);
  assert.equal((await reopenedProjects.list()).projects.length, 2);
  assert.equal(await (await reopenedProjects.connection()).current(), null, 'original default project is preserved');
  assert.deepEqual(taskWrites, [], 'neither import nor refresh/restart admits a synchronization task');
  const evidence = process.env.REPO_SYNC_EVIDENCE || join(targetFolder, 'evidence');
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, 'migration-real-settings-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(evidence, 'migration-real-settings-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: real production app/HTTP downloads a template, previews in an independent workspace, imports one project, preserves binding and original project across refresh/server restart, and never fetches external repositories or starts synchronization.',
  );
} catch (error) {
  console.log('Fixture migration feedback:', await page.locator('[data-transfer-feedback]').allTextContents(), errors);
  throw error;
} finally {
  await owner.close();
  await source.shutdown();
  await target.shutdown();
}

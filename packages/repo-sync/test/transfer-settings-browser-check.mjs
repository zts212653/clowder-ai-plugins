import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { launchOwnedBrowser } from './owned-browser.mjs';

// Component contract fixture: production settings modules, isolated API responses.
// Real Git objects, registry commit and duplicate-object recovery are covered by migration integration tests.
const web = fileURLToPath(new URL('../web/', import.meta.url));
const id = 'b'.repeat(24),
  binding = 'c'.repeat(64),
  packageId = 'd'.repeat(64);
const summary = {
  packageId,
  kind: 'migration',
  productVersion: '0.1.0',
  name: '原同步项目',
  sourceProjectId: 'default',
  bindingId: binding,
  sourceUrl: 'https://github.com/example/core.git',
  internalUrl: 'git@codehub.example:team/core.git',
  sourceBranch: 'main',
  targetBranch: 'main',
  mode: 'continuous',
  internalPaths: ['README.md'],
  historyCount: 3,
  taskCount: 7,
  issueCount: 4,
  accepted: { upstream: 'a'.repeat(40), internal: 'b'.repeat(40) },
  active: { id: 'current-delivery', status: 'WAITING_APPROVAL', prUrl: 'https://codehub.example/team/core/pull/8' },
};
let imported = false,
  active = false,
  checked = false,
  failCheck = true,
  github = false,
  platform = false;
let exported = false,
  rejectActivation = false,
  lostImportReceipt = true,
  platformExpired = false,
  registrationBlocked = true;
const requests = [],
  errors = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (url.pathname.startsWith('/api/')) {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : {};
    assert.equal(request.headers['x-repo-sync-token'], 'session-csrf');
    requests.push({ path: url.pathname, project: url.searchParams.get('project'), body });
    let result = {};
    if (url.pathname.endsWith('/preview')) {
      if (!body.valid) {
        response.statusCode = 409;
        result = { code: 'PACKAGE_INVALID', message: '文件摘要不匹配，请重新导出。' };
      } else result = { summary };
    } else if (url.pathname.endsWith('/import')) {
      if (registrationBlocked) {
        response.statusCode = 409;
        response.end(JSON.stringify({ code: 'CONFIGURATION_BUSY', message: '项目登记配置锁仍存在，请确认旧进程。' }));
        return;
      }
      imported = true;
      if (lostImportReceipt) {
        lostImportReceipt = false;
        response.statusCode = 503;
        response.end(
          JSON.stringify({ code: 'TRANSFER_RECEIPT_UNAVAILABLE', message: '原导入回执暂未取得，请保持同一包重试。' }),
        );
        return;
      }
      result = { project: { id, name: body.name }, transfer: { status: 'IMPORTED' } };
    } else if (url.pathname.endsWith('/recover-registration')) {
      assert.equal(body.confirmWritersStopped, true);
      registrationBlocked = false;
      result = { recovered: true };
    } else if (url.pathname.endsWith('/check')) {
      if (!checked) platformExpired = true;
      checked = true;
      result = { status: 'IMPORTED', checks: checks() };
    } else if (url.pathname.endsWith('/activate')) {
      assert.equal(body.confirmSingleWriter, true);
      assert.equal(failCheck, false);
      if (rejectActivation) {
        failCheck = true;
        result = { activated: false, transfer: { status: 'IMPORTED', checks: checks() } };
      } else {
        active = true;
        result = { activated: true, transfer: { status: 'ACTIVE' } };
      }
    } else if (url.pathname.endsWith('/export')) {
      exported = body.kind === 'migration';
      response.setHeader('Content-Disposition', 'attachment; filename="repo-sync-fixture.json"');
      result = { schema: 1, kind: body.kind, packageId };
    } else if (url.pathname === '/api/github-auth') github = Boolean(body.token);
    else if (url.pathname === '/api/issue-auth') {
      platform = Boolean(body.token);
      platformExpired = false;
    }
    response.end(JSON.stringify(result));
    return;
  }
  if (url.pathname === '/') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(harness(url.searchParams.get('project') === id, url.searchParams.has('configured')));
    return;
  }
  if (url.pathname === '/fixture-state') {
    response.end(
      JSON.stringify(fixtureSnapshot(url.searchParams.get('project') === id, url.searchParams.has('configured'))),
    );
    return;
  }
  try {
    const asset = url.pathname.slice(1);
    if (!/^[a-z-]+\.(mjs|css)$/.test(asset)) throw Error('unavailable');
    response.setHeader('Content-Type', asset.endsWith('.css') ? 'text/css' : 'text/javascript');
    response.end(await readFile(join(web, asset)));
  } catch {
    response.statusCode = 404;
    response.end('{}');
  }
});
function checks() {
  return [
    {
      key: 'binding',
      label: '两侧仓库绑定',
      status: failCheck ? 'FAILED' : 'PASSED',
      ...(failCheck ? { code: 'REMOTE_UNAVAILABLE', message: '内部仓库暂时无法读取，请检查 Git 认证后重试。' } : {}),
    },
    { key: 'runtime', label: '运行环境与路径', status: 'PASSED' },
    {
      key: 'platform-auth',
      label: '内部平台认证',
      status: platformExpired ? 'FAILED' : 'PASSED',
      ...(platformExpired ? { code: 'ISSUE_AUTH_EXPIRED', message: '内部平台 Token 已过期，请在当前项目更新。' } : {}),
    },
  ];
}
function fixtureSnapshot(selected, configured) {
  return {
    token: 'session-csrf',
    workspace: { revision: 'workspace-1' },
    connection: { revision: selected || configured ? 'config-1' : null },
    operation: null,
    config:
      selected || configured
        ? {
            bindingId: binding,
            mode: 'continuous',
            platformApi: { mode: 'gitlab', authentication: { available: platform } },
          }
        : null,
    sourceAuthentication: { available: github },
    ...(selected || exported
      ? {
          transfer: {
            status: exported && !selected ? 'EXPORTED' : active ? 'ACTIVE' : 'IMPORTED',
            kind: 'migration',
            packageId,
            summary,
            ...(checked ? { checks: checks() } : {}),
          },
        }
      : {}),
  };
}
function harness(selected, configured) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/transfers.css"><main><div id="error" hidden></div><div id="content"><section class="ordinary-settings">原仓库配置</section></div></main><script type="module">
import { createTransfers } from '/transfers.mjs'; import { createGithubAuthentication } from '/github-auth.mjs'; import { createIssueAuthentication } from '/issue-auth.mjs';
let data=${JSON.stringify(fixtureSnapshot(selected, configured))};
const content=document.querySelector('#content');
const refresh=async()=>{ data=await(await fetch('/fixture-state'+location.search)).json(); content.innerHTML='<section class="ordinary-settings">原仓库配置</section>'; transfers.render(content,'configuration'); };
const transfers=createTransfers(()=>data,refresh);
transfers.render(content,'configuration');
const ga=createGithubAuthentication(()=>data,refresh), ia=createIssueAuthentication(()=>data,refresh,document.querySelector('#error'));
document.addEventListener('submit',e=>{if(e.target.matches('[data-github-auth]')){e.preventDefault();void ga.submit(e.target)}if(e.target.matches('[data-secret-form]')){e.preventDefault();void ia.submit(e.target)}});
</script></html>`;
}
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const owner = await launchOwnedBrowser(chromium, { headless: true, executablePath: process.env.REPO_SYNC_CHROME });
const page = await owner.browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(10000);
page.on('pageerror', (error) => errors.push(error.message));
const base = `http://127.0.0.1:${server.address().port}`;
const evidence = process.env.REPO_SYNC_EVIDENCE || (await mkdtemp(join(tmpdir(), 'repo-sync-transfer-ui-')));
await mkdir(evidence, { recursive: true });
try {
  await page.goto(`${base}/?view=configuration`);
  await page.getByText('导入 / 导出配置与同步进度', { exact: true }).click();
  await page.getByRole('heading', { name: '配置与同步进度迁移', exact: true }).waitFor();
  await page
    .getByLabel('选择配置模板或完整迁移包')
    .setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await page.getByRole('button', { name: '读取并检查文件', exact: true }).click();
  await page
    .locator('[data-transfer-feedback]')
    .getByText(/PACKAGE_INVALID/)
    .waitFor();
  assert.equal(await page.locator('#error').isVisible(), false, 'file error stays beside import action');
  await page
    .getByLabel('选择配置模板或完整迁移包')
    .setInputFiles({ name: 'migration.json', mimeType: 'application/json', buffer: Buffer.from('{"valid":true}') });
  await page.getByRole('button', { name: '读取并检查文件', exact: true }).click();
  await page.getByLabel('导入后的项目名称').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.matches('.transfer-preview')), true);
  await page.getByText('历史 3 笔 · 执行记录 7 条 · Issue 映射 4 个', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => JSON.stringify({ ...sessionStorage }).includes('migration.json')), false);
  await page.getByLabel('导入后的项目名称').fill('我的迁移项目');
  await page.getByRole('button', { name: '导入为独立项目', exact: true }).click();
  await page.getByText('导入登记被中断？', { exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '恢复项目登记锁', exact: true }).isEnabled(), false);
  await page.getByLabel('已确认旧服务及其 Git / 检查子进程全部退出').check();
  await page.getByRole('button', { name: '恢复项目登记锁', exact: true }).click();
  await page.getByText(/项目登记锁已恢复/).waitFor();
  await page.getByRole('button', { name: '重试原导入（保持同一包）', exact: true }).click();
  await page.getByRole('button', { name: '重试原导入（保持同一包）', exact: true }).waitFor();
  assert.equal(await page.getByLabel('导入后的项目名称').getAttribute('readonly'), '');
  await page.getByRole('button', { name: '重试原导入（保持同一包）', exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get('project') === id);
  await page.getByRole('heading', { name: '完成迁移前核验', exact: true }).waitFor();
  assert.equal(await page.locator('.transfer-metadata').evaluate((element) => element.open), false);
  assert.equal(imported, true);
  assert.equal(await page.locator('.ordinary-settings').count(), 0);
  await page.reload();
  await page.getByRole('heading', { name: '完成迁移前核验', exact: true }).waitFor();
  await page.getByRole('button', { name: '内部平台认证', exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement.name), 'issueToken');
  await page.getByRole('button', { name: 'GitHub 认证', exact: true }).click();
  await page.getByLabel('GitHub 读取 Token').fill('recipient-source-token');
  const before = requests.filter((item) => item.path.endsWith('/check')).length;
  await page.getByRole('button', { name: '检查运行环境、仓库与认证', exact: true }).click();
  await page.getByText(/存在尚未提交的 Token/).waitFor();
  assert.equal(requests.filter((item) => item.path.endsWith('/check')).length, before);
  assert.equal(await page.getByLabel('GitHub 读取 Token').inputValue(), 'recipient-source-token');
  await page.getByRole('button', { name: '提供 GitHub 读取令牌', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await page.getByLabel('内部平台 Token', { exact: true }).fill('recipient-platform-token');
  await page.getByRole('button', { name: '提供 / 更换 Token（本次服务）', exact: true }).click();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: '检查运行环境、仓库与认证', exact: true }).click();
  await page.getByText(/REMOTE_UNAVAILABLE/).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.matches('.transfer-check-list .bad')), true);
  await page.screenshot({ path: join(evidence, 'migration-check-failed-desktop.png'), fullPage: false });
  await page.getByRole('button', { name: '提供 / 更新内部平台 Token →', exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement.name), 'issueToken');
  await page.getByLabel('内部平台 Token', { exact: true }).fill('recipient-platform-renewed');
  await page.getByLabel('我确认旧环境已停止推进，此接收分支只由本环境继续同步').check();
  assert.equal(await page.getByLabel('内部平台 Token', { exact: true }).inputValue(), 'recipient-platform-renewed');
  await page.getByRole('button', { name: '提供 / 更换 Token（本次服务）', exact: true }).click();
  await page.waitForLoadState('networkidle');
  assert.equal(await page.getByRole('button', { name: '确认启用此环境', exact: true }).isEnabled(), false);
  failCheck = false;
  await page.getByRole('button', { name: '重新检查迁移条件', exact: true }).click();
  await page.getByText('✓ 两侧仓库绑定', { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement.matches('.transfer-checks'));
  assert.equal(await page.evaluate(() => document.activeElement.matches('.transfer-checks')), true);
  await page.getByLabel('我确认旧环境已停止推进，此接收分支只由本环境继续同步').check();
  rejectActivation = true;
  await page.getByRole('button', { name: '确认启用此环境', exact: true }).click();
  await page.getByText(/迁移未启用/).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.matches('.transfer-check-list .bad')), true);
  assert.equal(active, false);
  assert.equal(await page.getByRole('button', { name: '确认启用此环境', exact: true }).isEnabled(), false);
  rejectActivation = false;
  failCheck = false;
  await page.getByRole('button', { name: '重新检查迁移条件', exact: true }).click();
  await page.getByText('✓ 两侧仓库绑定', { exact: true }).waitFor();
  await page.getByLabel('我确认旧环境已停止推进，此接收分支只由本环境继续同步').check();
  await page.getByRole('button', { name: '确认启用此环境', exact: true }).click();
  await page.getByText('迁移已启用；没有自动启动下一笔同步。', { exact: true }).waitFor();
  assert.equal(active, true);
  const imports = requests.filter((item) => item.path.endsWith('/import'));
  assert.equal(imports.length, 3);
  assert.deepEqual(imports[0].body, imports[1].body, 'lost receipt retries the original exact import');
  assert.deepEqual(imports[1].body, imports[2].body);
  assert.equal(
    imports[0].body.name,
    '我的迁移项目',
    'busy locks must not strip the project name from the submitted form',
  );
  for (const request of requests.filter((item) => !item.path.endsWith('/preview'))) {
    if (request.path.endsWith('/import')) assert.equal(request.body.expectedWorkspaceRevision, 'workspace-1');
    if (request.path.endsWith('/check') || request.path.endsWith('/activate')) {
      assert.equal(request.project, id);
      assert.equal(request.body.projectId, id);
      assert.equal(request.body.expectedRevision, 'config-1');
      assert.equal(request.body.expectedBinding, binding);
    }
  }
  assert.equal(
    await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }).includes('recipient-')),
    false,
  );
  assert.equal(
    await page
      .locator('body')
      .innerText()
      .then((text) => text.includes('recipient-')),
    false,
  );
  await page.screenshot({ path: join(evidence, 'migration-settings-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(evidence, 'migration-settings-mobile.png'), fullPage: true });
  await page.goto(`${base}/?view=configuration&configured=1`);
  await page.getByText('导入 / 导出配置与同步进度', { exact: true }).click();
  const templateDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出无凭据配置模板', exact: true }).click();
  assert.equal((await templateDownload).suggestedFilename(), 'repo-sync-template.json');
  await page.getByLabel('导出内容').selectOption('migration');
  await page.getByText(/导出将冻结此源项目并暂停推进/).waitFor();
  const fullDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '冻结项目并导出完整迁移包', exact: true }).click();
  assert.equal((await fullDownload).suggestedFilename(), 'repo-sync-migration.json');
  await page.getByRole('heading', { name: '源环境已停止推进', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '原环境继续使用', exact: true }).isEnabled(), false);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: isolated migration settings component, local errors, preview/import, scoped own authentication, failed/successful checks, explicit activation, no stored credentials and responsive layout.',
  );
} finally {
  await owner.close();
  await new Promise((done) => server.close(done));
}

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createProjectWorkspace } from '../src/projects.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { launchOwnedBrowser } from './owned-browser.mjs';

const folder = await mkdtemp(join(tmpdir(), 'repo-sync-navigation-'));
const projects = await createProjectWorkspace(join(folder, 'config.json'));
const other = await projects.create({
  action: 'create',
  name: '另一个项目',
  requestId: 'a'.repeat(32),
  expectedRevision: null,
});
const server = createReceiverServer(null, { projects, syncInterval: 60000 });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const { browser, close: closeBrowser } = await launchOwnedBrowser(chromium, {
  headless: true,
  executablePath: process.env.REPO_SYNC_CHROME,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
// Component harness uses the production navigation/history modules and real local project/record APIs.
await page.route('**/*', (route) => {
  const url = new URL(route.request().url());
  if (url.origin !== base || url.pathname !== '/') return route.continue();
  return route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/projects.css">
<section id="projects" class="project-bar"></section><label>普通草稿<input id="draft"></label><label>尚未提交的认证<input id="secret" type="password"></label><div id="history"></div>
<script type="module">
import { createProjectNavigation } from '/projects.mjs'; import { createHistory, recordList } from '/history.mjs';
const current = new URL(location.href).searchParams.get('project') ?? 'default';
const draft = document.querySelector('#draft'); draft.value = sessionStorage.getItem('ordinary:' + current) ?? '';
const data = await (await fetch('/api/projects')).json();
const snapshot = {token:data.token, config:{bindingId:'binding'}, state:{active:null}};
const nav = createProjectNavigation(() => snapshot, () => { if(window.failSave) return false; sessionStorage.setItem('ordinary:' + current, draft.value); return true; });
await nav.load();
let history; const render = () => document.querySelector('#history').innerHTML = recordList(history.get(), null);
history = createHistory(() => snapshot, render); await history.load(); render();
document.addEventListener('submit', e => { if(e.target.matches('[data-record-filter]')) { e.preventDefault(); history.filter(Object.fromEntries(new FormData(e.target))); }});
</script>`,
  });
});
try {
  await page.goto(`${base}/?project=default`);
  await page.locator('.project-sidebar-row.selected').waitFor();
  await page.getByLabel('普通草稿', { exact: true }).fill('项目 A 的草稿');
  await page.getByLabel('尚未提交的认证', { exact: true }).fill('private-token-must-not-persist');
  await page.locator(`.project-sidebar-list [data-project-enter="${other.id}"]`).click();
  await page.getByRole('alert').filter({ hasText: '尚未提交的 Token' }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('project'), 'default');
  assert.equal(await page.getByLabel('当前同步项目').inputValue(), 'default');
  await page.getByRole('button', { name: '留在当前项目', exact: true }).click();
  assert.equal(await page.getByLabel('尚未提交的认证').inputValue(), 'private-token-must-not-persist');
  assert.equal(
    await page.evaluate(() =>
      JSON.stringify({ ...sessionStorage }).includes('private-token-must-not-persist'),
    ),
    false,
  );
  await page.getByLabel('尚未提交的认证').fill('');
  await page.evaluate(() => {
    window.failSave = true;
  });
  await page.locator(`.project-sidebar-list [data-project-enter="${other.id}"]`).click();
  await page.getByRole('alert').filter({ hasText: '草稿保存失败' }).waitFor();
  await page.getByRole('button', { name: '留在当前项目', exact: true }).click();
  await page.evaluate(() => {
    window.failSave = false;
  });
  await page.locator(`.project-sidebar-list [data-project-enter="${other.id}"]`).click();
  await page.waitForURL((url) => url.searchParams.get('project') === other.id);
  await page.locator('.project-sidebar-row.selected').waitFor();
  assert.equal(await page.getByLabel('普通草稿').inputValue(), '');
  await page.getByLabel('普通草稿').fill('项目 B 的草稿');
  await page.locator('.project-sidebar-list [data-project-enter="default"]').click();
  await page.waitForURL((url) => url.searchParams.get('project') === 'default');
  await page.locator('.project-sidebar-row.selected').waitFor();
  assert.equal(await page.getByLabel('普通草稿').inputValue(), '项目 A 的草稿');
  await page.getByText('查看项目状态 · 2 个项目', { exact: true }).click();
  await page.getByRole('button', { name: '运行中', exact: true }).click();
  await page.getByText('没有符合当前状态的项目。可选择“全部”查看。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '需要处理', exact: true }).click();
  assert.equal(await page.locator('.project-overview .project-cards [data-project-enter]').count(), 2);
  assert.equal(await page.locator('.project-overview [data-action]').count(), 0);
  await page.getByLabel('搜索记录').fill('missing-tag');
  const dated = page.waitForResponse(
    (response) => response.url().includes('/api/records?') && response.url().includes('from='),
  );
  await page.getByRole('button', { name: '最近 7 天', exact: true }).click();
  const filtered = new URL((await dated).url());
  assert.equal(filtered.searchParams.get('q'), 'missing-tag');
  assert.equal(filtered.searchParams.get('project'), 'default');
  await page
    .getByText('没有符合筛选条件的记录。可调整关键词、状态，或清除日期范围。', {
      exact: true,
    })
    .waitFor();
  const cleared = page.waitForResponse(
    (response) =>
      response.url().includes('/api/records?') && !new URL(response.url()).searchParams.has('from'),
  );
  await page.getByRole('button', { name: '不限日期', exact: true }).click();
  assert.equal(new URL((await cleared).url()).searchParams.get('q'), 'missing-tag');
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: production project/history components with real local APIs, secret/discard and quota guards, isolated drafts, local filters, UTC shortcuts and four viewport widths.',
  );
} catch (error) {
  console.log('Component browser errors:', errors, '\nVisible page:', await page.locator('body').innerText());
  throw error;
} finally {
  await closeBrowser();
  await server.shutdown();
}

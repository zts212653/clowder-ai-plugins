import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createConnection } from '../src/connections.mjs';
import { setIssueToken } from '../src/issue-auth.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { codehubPlatform } from './codehub-fixture.mjs';
import { launchOwnedBrowser } from './owned-browser.mjs';
import { activateBaseline } from './setup-journey-helpers.mjs';
import { versionRepositories } from './version-fixtures.mjs';

const f = await versionRepositories(),
  platform = await codehubPlatform(f);
const root = await mkdtemp(join(tmpdir(), 'repo-sync-review-baseline-'));
const file = join(root, 'config.json');
const adapter = { mode: 'gitlab', apiUrl: platform.api, projectId: 'team/core', authMode: 'session' };
await writeFile(
  file,
  JSON.stringify({
    ...f.config,
    configurationSource: 'workbench',
    internalWebUrl: platform.web,
    pullRequests: adapter,
    issues: adapter,
  }),
);
const connection = await createConnection(file),
  receiver = await connection.current();
setIssueToken(receiver.config, platform.token, 'test');
const server = createReceiverServer(null, { connection, syncInterval: 100 });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const { browser, close } = await launchOwnedBrowser(chromium, { headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/?view=configuration`);
  await page.locator('#upstream').fill(f.u0);
  await page.locator('#internal').fill(f.i0);
  await page.getByRole('button', { name: '核验起点并查看文件 →', exact: true }).click();
  const panel = page.locator('#baseline-differences');
  await panel.waitFor({ timeout: 30000 });
  for (const path of ['OWNED.md', 'README.md', 'core.txt']) {
    await panel.locator(`[data-view-file="${path}"]`).click();
    await page.locator('#baseline-file-content h4').filter({ hasText: path }).waitFor();
    assert.equal(
      await page.locator('[data-baseline-path]').inputValue(),
      path,
      'selected path must match the loaded content after the request repaint',
    );
  }
  const fileName = panel.locator('.file-row > span[title="internal-docs/guide.md"]');
  assert.ok((await fileName.boundingBox()).width >= 100, 'nested file names must remain readable beside inherited-rule explanations');
  await page.screenshot({ path: join(root, 'baseline-two-column-1366.png'), fullPage: true });
  const tree = await panel.locator('.baseline-selection').boundingBox();
  const viewer = await panel.locator('.baseline-viewer').boundingBox();
  assert.ok(viewer.x > tree.x + tree.width, 'desktop tree and selected content share one review row');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(root, 'baseline-vertical-390.png'), fullPage: true });
  const mobileTree = await panel.locator('.baseline-selection').boundingBox();
  const mobileViewer = await panel.locator('.baseline-viewer').boundingBox();
  assert.ok(mobileViewer.y >= mobileTree.y + mobileTree.height, 'mobile review remains vertical');
  await page.setViewportSize({ width: 1366, height: 768 });
  let release, entered;
  const held = new Promise((done) => {
    release = done;
  });
  const started = new Promise((done) => {
    entered = done;
  });
  await page.route('**/api/action*', async (route) => {
    if (
      route.request().postDataJSON()?.action === 'baseline-file' &&
      route.request().postDataJSON().path === 'OWNED.md'
    ) {
      entered();
      await held;
    }
    await route.continue();
  });
  await panel.locator('[data-view-file="OWNED.md"]').click();
  await started;
  await panel.locator('[data-view-file="README.md"]').click();
  release();
  await page.locator('#baseline-file-content h4').filter({ hasText: 'README.md' }).waitFor();
  assert.equal(await page.locator('[data-baseline-path]').inputValue(), 'README.md');
  await page.unroute('**/api/action*');
  await panel.getByRole('button', { name: '应用选择并重新核验' }).click();
  await page.getByText(/所选内部保留规则已保存，核心文件核验通过/).waitFor({ timeout: 30000 });
  assert.doesNotMatch(await panel.innerText(), /尚未保存|内部保留草稿/);
  await page.reload();
  await page.locator('#baseline-differences').waitFor();
  assert.doesNotMatch(await page.locator('#baseline-differences').innerText(), /尚未保存|内部保留草稿/);
  await activateBaseline(page, await connection.current());
  await page.getByRole('button', { name: '读取可用 tag', exact: true }).click();
  await page.locator('[name="tag"]').selectOption('v2.0.0');
  await page.getByRole('button', { name: '同步到所选版本 →', exact: true }).click();
  await page.getByRole('link', { name: '打开内部 PR ↗', exact: true }).waitFor({ timeout: 30000 });
  await page.locator('[data-persist-details="commits"] > summary').click();
  const copy = page.locator('[data-copy-sha]').first();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await copy.click();
  await page.getByText('已复制', { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    await copy.getAttribute('data-copy-sha'),
  );
  await page.locator('[data-persist-details="commits"] > summary').click();
  await page.locator('.delivery-more > summary').click();
  await page.locator('.delivery-cancel > summary').click();
  for (const width of [1280, 1366, 1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: join(root, `expanded-${width}.png`), fullPage: true });
    console.log(
      `layout evidence: ${root}, width=${width}, links=${await page.locator('.delivery-links a').count()}`,
    );
    const link = page.locator('.delivery-links a').first();
    await link.waitFor();
    const box = await link.boundingBox();
    assert.ok(
      box.width >= 80 && box.height < 70,
      'expanded actions must not squeeze the source link into a vertical column',
    );
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(root, `expanded-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log(
    `PASS: file identity, queued selection, saved-versus-draft state, refresh, real version PR and expanded layout. Evidence: ${root}`,
  );
} finally {
  await close();
  await server.shutdown();
  await platform.close();
}

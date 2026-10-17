import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createConnection } from '../src/connections.mjs';
import { Receiver } from '../src/engine.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { gitPrFixture } from './git-pr-fixtures.mjs';
import { launchOwnedBrowser } from './owned-browser.mjs';

const f = await gitPrFixture();
const folder = await mkdtemp(join(tmpdir(), 'repo-sync-git-pr-web-'));
const configFile = join(folder, 'config.json');
await writeFile(configFile, JSON.stringify(f.config));
const receiver = new Receiver(f.config);
await receiver.adopt(f.u0, f.i0);
await receiver.selectTag('v2.0.0');
await receiver.start();
const connection = await createConnection(configFile);
const server = createReceiverServer(null, { connection });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const { browser, close: closeBrowser } = await launchOwnedBrowser(chromium, {
  headless: true,
  executablePath: process.env.REPO_SYNC_CHROME,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const evidence = process.env.REPO_SYNC_EVIDENCE || join(tmpdir(), 'repo-sync-git-pr-evidence');
await mkdir(evidence, { recursive: true });
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button', { name: '仓库设置', exact: true }).click();
  await page.locator('[data-settings-form]').waitFor();
  assert.equal(await page.getByLabel('PR 创建方式').inputValue(), 'git');
  await page.getByRole('button', { name: '保存设置并验证 →' }).click();
  await page.locator('[data-settings-result]').filter({ hasText: '设置已保存' }).waitFor();
  assert.equal((await connection.current()).config.pullRequests.mode, 'git');
  assert.equal((await (await connection.current()).status()).initial.upstream, f.u0);
  await page.getByRole('button', { name: '同步工作台', exact: true }).click();
  await page.getByRole('button', { name: '保留文件、检查并推送候选 →' }).click();
  await page.getByRole('link', { name: '打开内部 PR ↗', exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.locator('[data-form="pr"]:visible').count(), 0);
  assert.equal(
    await page.getByRole('link', { name: '打开内部 PR ↗', exact: true }).getAttribute('href'),
    'https://codehub.example/core/-/merge_requests/501',
  );
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    const geometry = await page.locator('.task-actions').evaluate((element) => {
      const children = [...element.children].map((child) => child.getBoundingClientRect());
      const [a, b] = children;
      return {
        gap: b.top >= a.bottom ? b.top - a.bottom : b.left - a.right,
        overflow: document.documentElement.scrollWidth > innerWidth,
        primary: getComputedStyle(element.children[0]).backgroundColor,
        secondary: getComputedStyle(element.children[1]).backgroundColor,
      };
    });
    assert.ok(geometry.gap >= 11, `buttons need visible separation: ${geometry.gap}`);
    assert.equal(geometry.overflow, false);
    assert.notEqual(geometry.primary, geometry.secondary);
    await page.screenshot({
      path: join(evidence, `automatic-pr-${width}.png`),
      fullPage: true,
    });
  }
  const automatic = await connection.current();
  await f.merge((await automatic.status()).active);
  await page.getByRole('button', { name: '已在平台合入，核验 Git 结果' }).click();
  await page.getByRole('heading', { name: '当前已接收版本' }).waitFor({ timeout: 30000 });
  assert.equal((await automatic.status()).accepted.tag, 'v2.0.0');
  const received = JSON.parse(await readFile(f.resultFile));
  assert.ok(received.opts.includes('merge_request.create'));
  assert.deepEqual(errors, []);
  console.log(
    'PASS: existing binding enables Git PR; candidate push automatically registers PR; no manual creation/link step; separated primary/secondary buttons at 1440/390; real Git merge verified.',
  );
} finally {
  await page.close();
  await closeBrowser();
  await server.shutdown();
}

const assert = require('node:assert/strict');
const { mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromium } = require(process.env.REPO_SYNC_PLAYWRIGHT || 'playwright');
const evidence = process.env.REPO_SYNC_EVIDENCE || join(tmpdir(), 'repo-sync-delivery-evidence');
const key = 'clowder-repo-sync-demo-v2';
const { fixture } = require('./browser-fixtures.cjs');
async function run() {
  await mkdir(evidence, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.REPO_SYNC_CHROME ? { executablePath: process.env.REPO_SYNC_CHROME } : {}),
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    const read = () => page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey)), key);
    await page.goto(process.env.REPO_SYNC_PROTOTYPE_URL || 'http://127.0.0.1:5186');
    await fixture(page, 'waiting');
    await page.locator('#open-pr').waitFor();
    assert.equal(await page.locator('.nav-item[data-view="events"]').count(), 0);
    assert.match(await page.locator('#current-task .branch-path').innerText(), /sync\/delivery-041[\s\S]*main/);
    await page.locator('#current-task .pr-name > summary').click();
    assert.match(await page.locator('#current-task .pr-name').innerText(), /\[上游同步\] PR #84/);
    await page.locator('#technical-details > summary').click();
    await page.locator('[data-phase="7"]').click();
    assert.equal((await read()).active.phase, 6);
    assert.equal(await page.locator('#auto-step').count(), 0);
    await fixture(page, 'verify');
    assert.equal((await read()).active.phase, 7);
    const accepted = (await read()).accepted;
    await page.locator('#demo-toggle').click();
    assert.equal(await page.locator('#demo-controls').isVisible(), false);
    assert.equal(await page.locator('#current-task #auto-step').isVisible(), true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => getComputedStyle(document.getElementById('toast')).opacity === '0');
    await page.screenshot({ path: join(evidence, '11-post-merge-verification.png'), fullPage: false });
    await page.locator('#auto-step').click();
    assert.equal((await read()).active.phase, 8);
    assert.notEqual((await read()).accepted, accepted);
    assert.match(await page.locator('#auto-step').innerText(), /完成同步/);
    await page.locator('#auto-step').click();
    assert.equal((await read()).active.phase, 9);
    assert.equal(await page.locator('#auto-step').count(), 0);
    await page.locator('#demo-toggle').click();
    await page.locator('#scenario').selectOption('behind');
    await page.locator('#start').click();
    for (let i = 0; i < 5; i++) await page.locator('#advance').click();
    const [pr] = await Promise.all([page.waitForEvent('popup'), page.locator('#open-pr').click()]);
    await pr.locator('#platform-note').fill('sentinel-仅第一笔交付-审计备注');
    assert.match(await pr.locator('h1').innerText(), /\[上游同步\] PR #84/);
    assert.match(await pr.locator('.page-heading').innerText(), /sync\/delivery-041/);
    await pr.getByRole('button', { name: '模拟在平台合入 PR #92' }).click();
    await page.locator('#auto-step').waitFor();
    assert.match(await pr.locator('.audit-panel').innerText(), /sentinel-仅第一笔交付-审计备注/);
    await pr.close();
    await page.locator('.delivery[data-delivery="delivery-041"]').click();
    await page.locator('#delivery [data-audit]').click();
    assert.match(await page.locator('#delivery .audit-panel').innerText(), /sentinel-仅第一笔交付-审计备注/);
    await page.locator('#external').click();
    assert.doesNotMatch(await page.locator('#delivery .audit-panel').innerText(), /外部新交付加入队列/);
    await page.locator('#delivery [data-map]').click();
    assert.equal(await page.locator('#mapping .audit-panel').count(), 0);
    await page.locator('#mapping [data-delivery="delivery-041"]').first().click();
    await page.locator('#delivery [data-audit]').click();
    assert.match(await page.locator('#delivery .audit-panel').innerText(), /候选分支|sync\/delivery-041/);
    await page.locator('#auto-step').click();
    await page.locator('#auto-step').click();
    await page.locator('#current-task [data-view="overview"]').click();
    await page.locator('#start').click();
    for (let i = 0; i < 5; i++) await page.locator('#advance').click();
    const [secondPr] = await Promise.all([page.waitForEvent('popup'), page.locator('#open-pr').click()]);
    await secondPr.locator('.audit-panel').waitFor();
    assert.doesNotMatch(await secondPr.locator('.audit-panel').innerText(), /sentinel-仅第一笔交付-审计备注/);
    assert.match(await secondPr.locator('.page-heading').innerText(), /sync\/delivery-042/);
    await secondPr.close();
    await page.locator('.delivery[data-delivery="delivery-041"]').click();
    await page.locator('#delivery [data-audit]').click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => getComputedStyle(document.getElementById('toast')).opacity === '0');
    await page.screenshot({ path: join(evidence, '12-delivery-audit.png'), fullPage: true });
    await page.reload();
    await page.locator('.delivery[data-delivery="delivery-041"]').click();
    await page.locator('#delivery [data-audit]').click();
    assert.match(await page.locator('#delivery .audit-panel').innerText(), /sentinel-仅第一笔交付-审计备注/);
    assert.equal((await read()).active.id, 'delivery-042');
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const sizes = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ]);
      assert.ok(sizes[0] <= sizes[1], `delivery detail overflow at ${width}`);
      if (width === 390) await page.screenshot({ path: join(evidence, '13-delivery-mobile.png'), fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log(
      'PASS：分支 / PR 命名、浏览节点不改状态、隐藏演示条后继续核验、7→8→9、流程和 PR 审计隔离、映射独立、历史审计刷新恢复及四种屏宽。',
    );
    console.log(`证据：${evidence}`);
  } finally {
    await browser.close();
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

const assert = require('node:assert/strict');
const { mkdir } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { chromium } = require(process.env.REPO_SYNC_PLAYWRIGHT || 'playwright');
const evidence = process.env.REPO_SYNC_EVIDENCE || join(tmpdir(), 'repo-sync-prototype-evidence');
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
    await page.goto(process.env.REPO_SYNC_PROTOTYPE_URL || 'http://127.0.0.1:5186');
    await fixture(page, 'waiting');
    await page.locator('#open-pr').waitFor();
    assert.equal(await page.locator('#approval-dialog').count(), 0);
    const read = () => page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey)), key);
    const scenario = async (name) => {
      await fixture(page, name);
    };
    const approve = async (note) => {
      const expected = (await read()).active.internalPr;
      const beforeNavigation = (await read()).internalSha;
      const [prPage] = await Promise.all([page.waitForEvent('popup'), page.locator('#open-pr').click()]);
      await prPage.waitForURL(`**/internal/demo/core/pull/${expected}?binding=*`);
      assert.equal((await read()).internalSha, beforeNavigation);
      if (expected === 93) assert.doesNotMatch(await prPage.locator('#pr-content').innerText(), /第一笔审批通过/);
      await prPage.locator('#platform-note').fill(note);
      await prPage.screenshot({ path: join(evidence, '07-specific-pr-page.png'), fullPage: true });
      await prPage.getByRole('button', { name: `模拟在平台合入 PR #${expected}` }).click();
      await page.locator('#auto-step').waitFor({ state: 'visible' });
      assert.equal((await read()).active.phase, 7);
      await prPage.close();
    };
    const finish = async () => {
      await page.locator('#auto-step').click();
      assert.equal((await read()).active.phase, 8);
      assert.equal((await read()).accepted, (await read()).active.target);
      await page.locator('#auto-step').click();
      assert.equal((await read()).active.phase, 9);
    };
    await page.screenshot({ path: join(evidence, '01-overview-desktop.png'), fullPage: true });
    await scenario('waiting');
    const frozen = (await read()).active.target;
    await page.locator('#external').click();
    assert.equal((await read()).active.target, frozen);
    assert.notEqual((await read()).latest, frozen);
    await approve('sentinel-用户输入-20261010-α');
    let state = await read();
    assert.equal(state.active.phase, 7);
    assert.notEqual(state.accepted, frozen);
    assert.notEqual(state.accepted, state.internalSha);
    await finish();
    await page.locator('.delivery[data-delivery="delivery-041"]').click();
    await page.locator('#delivery-audit > summary').click();
    assert.match(await page.locator('#delivery .audit-panel').innerText(), /sentinel-用户输入-20261010-α/);
    await page.reload();
    await page.locator('.delivery[data-delivery="delivery-041"]').click();
    await page.locator('#delivery-audit > summary').click();
    assert.match(await page.locator('#delivery .audit-panel').innerText(), /sentinel-用户输入-20261010-α/);
    await page.screenshot({ path: join(evidence, '02-audit-persisted.png'), fullPage: true });
    await scenario('behind');
    await page.locator('#start').click();
    for (let i = 0; i < 5; i++) await page.locator('#advance').click();
    assert.equal((await read()).internalSha, '10a91f20');
    await approve('第一笔审批通过');
    await finish();
    await page.locator('#start').click();
    for (let i = 0; i < 5; i++) await page.locator('#advance').click();
    await approve('第二笔审批通过');
    await finish();
    assert.match(await page.locator('#current-task h2').innerText(), /已接收外部最新版本/);
    state = await read();
    assert.equal(state.latest, state.accepted);
    assert.notEqual(state.internalSha, state.latest);
    await scenario('timeout');
    const pr = (await read()).active.internalPr;
    await page.locator('#recover').click();
    assert.equal((await read()).active.internalPr, pr);
    assert.equal((await read()).active.phase, 5);
    await scenario('plugin');
    const before = (await read()).internalSha;
    assert.equal(await page.locator('#open-pr').count(), 0);
    await page.locator('.delivery[data-delivery="delivery-041"]').click();
    await page.locator('#check-details > summary').click();
    assert.match(await page.locator('#check-details').innerText(), /候选与目标一致/);
    assert.match(await page.locator('#check-details').innerText(), /检查失败/);
    await page.screenshot({ path: join(evidence, '05-plugin-blocked.png'), fullPage: true });
    await page.locator('#recover').click();
    assert.equal((await read()).internalSha, before);
    await page.locator('#open-pr').waitFor();
    await scenario('drift');
    await page.locator('#inspect-drift').click();
    assert.equal(await page.locator('#recover').isDisabled(), true);
    await scenario('metadata');
    const acceptedSha = (await read()).internalSha;
    assert.match(await page.locator('#current-task h2').innerText(), /代码已同步.*待补齐/);
    await page.screenshot({ path: join(evidence, '06-code-accepted-metadata-pending.png'), fullPage: true });
    await page.locator('#recover').click();
    assert.equal((await read()).internalSha, acceptedSha);
    assert.match(await page.locator('#current-task h2').innerText(), /已接收外部最新版本/);
    await scenario('waiting');
    await page.locator('#overview [data-map]').click();
    assert.match(await page.locator('#mapping').innerText(), /bf903a62/);
    assert.match(await page.locator('#mapping').innerText(), /内部 #318/);
    await page.screenshot({ path: join(evidence, '03-commit-mapping.png'), fullPage: true });
    await page.locator('#mapping-delivery').selectOption('delivery-042');
    assert.match(await page.locator('#mapping').innerText(), /Squash/);
    await page.locator('#adapter-button').click();
    assert.equal(await page.locator('#adapter-dialog').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#adapter-dialog').isVisible(), false);
    await page.locator('[data-view="overview"]').first().click();
    await page.locator('#technical-details > summary').click();
    await page.locator('[data-phase="3"]').click();
    await page.locator('#phase-detail summary').click();
    assert.match(await page.locator('#phase-detail').innerText(), /git fetch/);
    await page.locator('#demo-toggle').click();
    assert.equal(await page.locator('#demo-controls').isVisible(), false);
    await page.locator('#demo-toggle').click();
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const dimensions = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      assert.ok(
        dimensions.scroll <= dimensions.client,
        `horizontal overflow at ${width}: ${JSON.stringify(dimensions)}`,
      );
      if (width === 390) {
        await page.waitForFunction(() => getComputedStyle(document.getElementById('toast')).opacity === '0');
        await page.screenshot({ path: join(evidence, '04-mobile.png'), fullPage: true });
      }
    }
    assert.deepEqual(errors, []);
    console.log(
      'PASS：审批与顺序交付、冻结目标、超时查回、插件阻塞、核心偏移、元数据恢复、刷新持久化、映射与四种屏宽。',
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

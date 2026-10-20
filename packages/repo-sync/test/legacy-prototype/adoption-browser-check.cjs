const assert = require('node:assert/strict');
const { mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromium } = require(process.env.REPO_SYNC_PLAYWRIGHT || 'playwright');
const evidence = process.env.REPO_SYNC_EVIDENCE || join(tmpdir(), 'repo-sync-adoption-evidence');
const externalA = 'aa713c891234567890abcdef1234567890abcdef';
const internalB = 'bb824d901234567890abcdef1234567890abcdef';
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
    const read = () => page.evaluate(() => JSON.parse(localStorage.getItem('clowder-repo-sync-demo-v2')));
    await page.goto(process.env.REPO_SYNC_PROTOTYPE_URL || 'http://127.0.0.1:5186');
    await page.locator('#current-task .primary').click();
    await page.locator('#next-binding').click();
    assert.equal(await page.locator('[name="mode"][value="adopt"]').isChecked(), true);
    await page.locator('#config-baseline').fill(externalA);
    await page.locator('#config-internalBaseline').fill(internalB);
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
        `baseline form overflow at ${width}`,
      );
      if (width === 1440 || width === 390)
        await page.screenshot({ path: join(evidence, `18-existing-baseline-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.locator('#next-binding').click();
    await page.locator('.wizard-advanced > summary').click();
    for (const outcome of ['tree-mismatch', 'head-moved']) {
      await page.locator('#demo-baseline-outcome').selectOption(outcome);
      await page.locator('#check-binding').click();
      assert.match(await page.locator('#wizard-error').innerText(), /基线核验失败/);
      assert.equal(await page.locator('#save-binding').count(), 0);
      assert.equal((await read()).accepted, null);
      await page.locator('.wizard-advanced > summary').click();
    }
    await page.locator('#demo-baseline-outcome').selectOption('match');
    await page.locator('#check-binding').click();
    assert.match(await page.locator('#baseline-check').innerText(), /模拟结果/);
    assert.ok((await page.locator('.connection-facts').innerText()).includes(internalB));
    await page.locator('#save-binding').click();
    assert.equal((await read()).binding.status, 'saved');
    assert.equal((await read()).accepted, null);
    await page.reload();
    await page.locator('#current-task .primary').click();
    await page.locator('#initialize-binding').click();
    let state = await read();
    assert.equal(state.accepted, externalA);
    assert.equal(state.internalSha, internalB);
    assert.equal(state.binding.initialInternalSha, internalB);
    assert.equal(state.active, null);
    assert.match(await page.locator('.workbench-status').innerText(), /20 个提交.*4 笔 PR/);
    await page.screenshot({ path: join(evidence, '19-twenty-commits-pending.png'), fullPage: true });
    const seen = [];
    for (let index = 0; index < 4; index++) {
      const accepted = state.accepted;
      const internal = state.internalSha;
      await page.locator('#current-task .primary').click();
      assert.equal((await read()).internalSha, internal);
      for (let step = 0; step < 5; step++) await page.locator('#current-task .primary').click();
      const [pr] = await Promise.all([page.waitForEvent('popup'), page.locator('#current-task .primary').click()]);
      await pr.locator('#platform-note').fill(`sentinel-接管后第 ${index + 1} 笔审核`);
      await pr.locator('#platform-merge button').click();
      await page.locator('#auto-step').waitFor();
      state = await read();
      assert.equal(state.accepted, accepted);
      seen.push(state.active.internalPr);
      await pr.close();
      await page.locator('#current-task .primary').click();
      state = await read();
      assert.equal(state.accepted, state.active.target);
      await page.locator('#current-task .primary').click();
      state = await read();
      assert.equal(state.active.phase, 9);
    }
    assert.equal(new Set(seen).size, 4);
    assert.equal(state.accepted, state.latest);
    assert.notEqual(state.internalSha, state.latest);
    assert.match(await page.locator('#current-task h2').innerText(), /最新版本/);
    await page.locator('#overview [data-map]').click();
    assert.ok((await page.locator('#mapping').innerText()).includes('bb824d90'));
    assert.match(await page.locator('#mapping').innerText(), /已有版本对应.*接管登记/);
    await page.locator('.nav-item[data-view="configuration"]').click();
    assert.ok((await page.locator('.config-readonly').innerText()).includes(state.latest));
    assert.ok((await page.locator('.config-readonly').innerText()).includes(state.internalSha));
    assert.ok((await page.locator('.connection-facts').innerText()).includes(internalB));
    await page.reload();
    assert.equal((await read()).binding.internalBaseline, internalB);
    assert.equal((await read()).accepted, state.latest);
    await page.screenshot({ path: join(evidence, '20-adoption-synced.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(
      'PASS：已有仓 A/B 基线、不同 SHA、两类核验失败阻断、保存刷新、保留 B、20 提交按 4 个 PR 顺序接收、核验后推进游标与四种屏宽。',
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

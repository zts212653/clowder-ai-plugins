const assert = require('node:assert/strict');
const { mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { fixture } = require('./browser-fixtures.cjs');
const { chromium } = require(process.env.REPO_SYNC_PLAYWRIGHT || 'playwright');
const evidence = process.env.REPO_SYNC_EVIDENCE || join(tmpdir(), 'repo-sync-binding-evidence');
const key = 'clowder-repo-sync-demo-v2';
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
    const config = () => page.locator('.nav-item[data-view="configuration"]').click();
    await page.goto(process.env.REPO_SYNC_PROTOTYPE_URL || 'http://127.0.0.1:5186');
    assert.equal(await page.locator('#demo-controls').isVisible(), false);
    assert.equal(await page.locator('#start').count(), 0);
    await fixture(page, 'waiting');
    await config();
    assert.match(await page.locator('#binding-lock').innerText(), /未完成同步/);
    assert.equal(await page.locator('#edit-binding').isDisabled(), true);
    await fixture(page, 'unconfigured');
    await page.locator('#current-task .primary').click();
    assert.equal(await page.locator('#config-externalUrl').inputValue(), 'https://github.com/demo/core.git');
    assert.equal(await page.locator('[name="externalProfile"], [name="internalProfile"]').count(), 0);
    await page.locator('#config-externalUrl').fill('');
    await page.locator('#config-internalUrl').fill('');
    await page.locator('#next-binding').click();
    assert.match(await page.locator('#wizard-error').innerText(), /填入示例仓库/);
    await page.locator('#example-binding').click();
    assert.equal(await page.locator('#wizard-error').count(), 0);
    assert.equal(await page.locator('#config-externalUrl').inputValue(), 'https://github.com/demo/core.git');
    assert.equal(await page.locator('#config-internalUrl').inputValue(), 'git@codehub.example:demo/core.git');
    const external = 'https://github.com/sentinel-lab/sentinel-core.git';
    const internal = 'git@codehub.example:team/sentinel-core.git';
    const baseline = 'aa713c891234567890abcdef1234567890abcdef';
    const internalBaseline = 'bb824d901234567890abcdef1234567890abcdef';
    const fields = {
      externalUrl: external,
      internalUrl: internal,
      sourceBranch: 'release/2',
      targetBranch: 'delivery-main',
    };
    for (const [field, value] of Object.entries(fields)) await page.locator(`#config-${field}`).fill(value);
    await page.locator('.wizard-advanced > summary').click();
    await page.locator('#config-internalWebUrl').fill('https://codehub.example/team/sentinel-core');
    await page.locator('#config-externalUrl').fill('https://synthetic-credential@github.com/example/core.git');
    await page.locator('#next-binding').click();
    assert.match(await page.locator('#wizard-error').innerText(), /不含凭据/);
    assert.equal((await read()).binding.externalUrl, '');
    await page.locator('#config-externalUrl').fill(external);
    await page.locator('#next-binding').click();
    await page.locator('#config-baseline').fill('invalid-baseline');
    await page.locator('#next-binding').click();
    assert.match(await page.locator('#wizard-error').innerText(), /commit ID/);
    await page.locator('#config-baseline').fill(baseline);
    await page.locator('#config-internalBaseline').fill(internalBaseline);
    await page.locator('#next-binding').click();
    await page.locator('#check-binding').click();
    assert.equal(await page.locator('#save-binding').isEnabled(), true);
    assert.match(await page.locator('#config-result').innerText(), /真实连接.*尚未接入/);
    await page.locator('#previous-binding').click();
    await page.locator('#config-baseline').fill('bb713c89');
    await page.locator('#next-binding').click();
    assert.equal(await page.locator('#save-binding').count(), 0);
    await page.locator('#previous-binding').click();
    await page.locator('#config-baseline').fill(baseline);
    await page.locator('#next-binding').click();
    await page.locator('#check-binding').click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => getComputedStyle(document.getElementById('toast')).opacity === '0');
    await page.screenshot({ path: join(evidence, '08-repository-configuration.png'), fullPage: true });
    await page.locator('#save-binding').click();
    let state = await read();
    assert.equal(state.binding.status, 'saved');
    assert.equal(state.accepted, null);
    assert.equal(state.active, null);
    assert.ok(state.archives.length);
    await page.locator('#previous-binding').click();
    await page.locator('#config-baseline').fill('bb713c89');
    await page.locator('#next-binding').click();
    assert.equal(await page.locator('#initialize-binding').count(), 0);
    await page.reload();
    await page.locator('#current-task .primary').click();
    await page.locator('#initialize-binding').click();
    state = await read();
    assert.equal(state.binding.status, 'ready');
    assert.equal(state.accepted, baseline);
    assert.equal(state.internalSha, internalBaseline);
    assert.equal(await page.locator(`#overview [data-copy="${baseline}"]`).getAttribute('title'), baseline);
    await config();
    const facts = await page.locator('.connection-facts').innerText();
    for (const value of [external, internal, fields.sourceBranch, fields.targetBranch])
      assert.ok(facts.includes(value));
    await page.locator('.config-readonly [data-view="overview"]').click();
    await page.locator('#overview [data-map]').click();
    assert.match(await page.locator('#mapping').innerText(), /aa713c89/);
    assert.match(await page.locator('#mapping').innerText(), /bb824d90/);
    await page.reload();
    assert.equal((await read()).binding.internalUrl, internal);
    assert.equal((await read()).accepted, baseline);
    await fixture(page, 'behind');
    assert.equal((await read()).binding.externalUrl, external);
    await page.locator('#demo-toggle').click();
    await page.waitForFunction(() => getComputedStyle(document.getElementById('toast')).opacity === '0');
    await page.screenshot({ path: join(evidence, '09-configured-overview.png'), fullPage: true });
    await page.locator('#start').click();
    for (let i = 0; i < 5; i++) await page.locator('#advance').click();
    const [pr] = await Promise.all([page.waitForEvent('popup'), page.locator('#open-pr').click()]);
    await pr.locator('#platform-note').waitFor();
    assert.match(await pr.locator('#pr-content').innerText(), /delivery-main/);
    assert.match(await pr.locator('#pr-content').innerText(), /sentinel-core/);
    const stale = await browser.newPage();
    await stale.goto('http://127.0.0.1:5186/internal/demo/core/pull/92?binding=obsolete-binding');
    assert.match(await stale.locator('#pr-content').innerText(), /旧 PR 页面不能操作/);
    assert.equal(await stale.locator('#platform-merge').count(), 0);
    await stale.close();
    await pr.close();
    await config();
    assert.equal(await page.locator('#edit-binding').isDisabled(), true);
    assert.equal((await read()).binding.internalUrl, internal);
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const dimensions = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ]);
      assert.ok(dimensions[0] <= dimensions[1], `configuration overflow at ${width}`);
      if (width === 390) await page.screenshot({ path: join(evidence, '10-configuration-mobile.png'), fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log(
      'PASS：分步配置、地址凭据拒绝、编辑后重查、初始化门禁、自定义映射、刷新保留、活动绑定保护、旧 PR 拒绝与四种屏宽。',
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

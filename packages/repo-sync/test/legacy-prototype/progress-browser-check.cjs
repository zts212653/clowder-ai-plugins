const assert = require('node:assert/strict');
const { mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { fixture } = require('./browser-fixtures.cjs');
const { chromium } = require(process.env.REPO_SYNC_PLAYWRIGHT || 'playwright');
const evidence = process.env.REPO_SYNC_EVIDENCE || join(tmpdir(), 'repo-sync-progress-evidence');
async function checkFailedOperations(page, read) {
  for (const [scenario, phase, code] of [
    ['drift', 1, 'CORE_BASELINE_MISMATCH'],
    ['timeout', 4, 'PR_CREATE_TIMEOUT'],
    ['plugin', 5, 'PLUGIN_INCOMPATIBLE'],
    ['metadata', 8, 'ISSUE_CLOSE_FAILED'],
  ]) {
    await fixture(page, scenario);
    const before = await read();
    assert.equal(await page.locator('.substep.failed').count(), 1);
    assert.equal(await page.locator(`.substep.failed[data-step="${phase}"] b`).innerText(), '×');
    assert.match(await page.locator('.step-failure').innerText(), new RegExp(code));
    assert.equal(await page.locator('.step-failure').isVisible(), true);
    if (scenario === 'plugin') {
      await page.locator('#demo-toggle').click();
      await page.waitForFunction(() => getComputedStyle(document.getElementById('toast')).opacity === '0');
      await page.screenshot({ path: join(evidence, '22-failed-step-desktop.png'), fullPage: true });
    }
    if (scenario === 'drift') continue;
    await page.locator('#current-task .primary').click();
    const after = await read();
    assert.equal(after.internalSha, before.internalSha);
    assert.equal(after.active.internalPr, before.active.internalPr);
    assert.equal(after.active.internalIssue, before.active.internalIssue);
    assert.equal(await page.locator('.step-failure').count(), 0);
    if (scenario === 'metadata') assert.equal(after.active.issueResult, 'closed-by-sync');
  }
}
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
    await checkFailedOperations(page, read);
    await fixture(page, 'behind');
    await page.locator('#start').click();
    assert.equal(await page.locator('.milestones > li').count(), 5);
    assert.equal(await page.locator('.milestone-children').first().locator('.substep').count(), 5);
    assert.doesNotMatch(await page.locator('.task-main').innerText(), /\d\/5/);
    for (let step = 1; step <= 5; step++) {
      assert.equal(await page.locator(`.substep[data-step="${step}"]`).getAttribute('data-step-status'), 'current');
      await page.locator('#advance').click();
      assert.equal(await page.locator(`.substep[data-step="${step}"]`).getAttribute('data-step-status'), 'done');
    }
    const mapped = (await read()).active.internalIssue;
    const [pr] = await Promise.all([page.waitForEvent('popup'), page.locator('#open-pr').click()]);
    await pr.locator('#platform-note').fill('sentinel-子步骤和关单结果验证');
    await pr.locator('#platform-merge button').click();
    await page.locator('#auto-step').waitFor();
    await pr.close();
    await page.locator('#auto-step').click();
    assert.match(await page.locator('.issue-explanation').innerText(), /准备阶段已完成创建与映射/);
    assert.match(await page.locator('.issue-explanation').innerText(), /平台已关闭/);
    await page.locator('#auto-step').click();
    assert.equal((await read()).active.issueResult, 'already-closed');
    assert.equal((await read()).active.internalIssue, mapped);
    for (const [scenario, expectedStatus, result] of [
      ['manual-close', 'closed', 'closed-by-sync'],
      ['related-issue', 'open', 'left-unchanged'],
    ]) {
      await fixture(page, scenario);
      const before = await read();
      assert.match(
        await page.locator('.issue-explanation').innerText(),
        scenario === 'manual-close' ? /待补充关闭/ : /普通关联/,
      );
      await page.locator('#auto-step').click();
      const after = await read();
      assert.equal(after.active.issueStatus, expectedStatus);
      assert.equal(after.active.issueResult, result);
      assert.equal(after.internalSha, before.internalSha);
      assert.equal(after.active.internalIssue, before.active.internalIssue);
    }
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const scenario of ['plugin', 'metadata', 'related-issue', 'reconcile']) {
        await fixture(page, scenario);
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
          `progress overflow: ${scenario} at ${width}`,
        );
      }
      if (width === 1440) {
        await page.locator('#demo-toggle').click();
        await page.waitForFunction(() => getComputedStyle(document.getElementById('toast')).opacity === '0');
        await page.screenshot({ path: join(evidence, '23-confirm-closed-issue.png'), fullPage: true });
      }
      if (width === 390) {
        await fixture(page, 'plugin');
        await page.locator('#demo-toggle').click();
        await page.waitForFunction(() => getComputedStyle(document.getElementById('toast')).opacity === '0');
        await page.screenshot({ path: join(evidence, '24-failed-step-mobile.png'), fullPage: true });
      }
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    await fixture(page, 'behind');
    await page.locator('#demo-toggle').click();
    await page.locator('#start').click();
    await page.locator('#advance').click();
    await page.locator('#advance').click();
    await page.waitForFunction(() => getComputedStyle(document.getElementById('toast')).opacity === '0');
    await page.screenshot({ path: join(evidence, '21-preparation-child-steps.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(
      'PASS：五个准备子步骤、异常 × 与对应信息、恢复复用对象、平台已关闭只确认、程序补充关闭、普通关联保留状态及四种屏宽。',
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

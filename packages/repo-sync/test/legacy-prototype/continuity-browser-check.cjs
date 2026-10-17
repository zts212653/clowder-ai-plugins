const assert = require('node:assert/strict');
const { mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { fixture } = require('./browser-fixtures.cjs');
const { chromium } = require(process.env.REPO_SYNC_PLAYWRIGHT || 'playwright');
const evidence = process.env.REPO_SYNC_EVIDENCE || join(tmpdir(), 'repo-sync-continuity-evidence');
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
    const read = () => page.evaluate(() => JSON.parse(localStorage.getItem('clowder-repo-sync-demo-v2')));
    await page.goto(process.env.REPO_SYNC_PROTOTYPE_URL || 'http://127.0.0.1:5186');
    await fixture(page, 'shared-issue');
    for (let index = 0; index < 2; index++) {
      await page.locator('#start').click();
      for (let step = 0; step < 5; step++) await page.locator('#advance').click();
      const [pr] = await Promise.all([page.waitForEvent('popup'), page.locator('#open-pr').click()]);
      await pr.locator('#platform-note').fill('合成验证：共享 Issue 按两笔交付接收');
      await pr.locator('#platform-merge button').click();
      await page.locator('#auto-step').waitFor();
      await pr.close();
      await page.locator('#auto-step').click();
      await page.locator('#auto-step').click();
      const state = await read();
      assert.equal(state.active.phase, 9);
      assert.equal(state.active.issueStatus, index ? 'closed' : 'open');
      assert.equal(state.active.internalIssue, 318);
      if (!index) {
        assert.match(await page.locator('.queue-panel').innerText(), /等待后续交付/);
        await page.screenshot({ path: join(evidence, '25-prototype-shared-issue.png'), fullPage: true });
      }
    }
    await fixture(page, 'merge-interrupted');
    const before = await read();
    await page.getByRole('button', { name: '核对合入结果并恢复' }).click();
    const restored = await read();
    assert.equal(restored.active.phase, 8);
    assert.equal(restored.internalSha, before.internalSha);
    assert.equal(restored.active.internalPr, before.active.internalPr);
    await fixture(page, 'merge-conflict');
    const conflict = await read();
    await page.getByRole('button', { name: '核对合入结果并恢复' }).click();
    assert.match(await page.locator('.step-failure').innerText(), /MERGE_RESULT_CONFLICT/);
    assert.equal((await read()).accepted, conflict.accepted);
    assert.deepEqual(errors, []);
    console.log('PASS：共享 Issue 跨两笔交付、合入后恢复原对象、冲突暂停与对应 × 报错。');
  } finally {
    await browser.close();
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

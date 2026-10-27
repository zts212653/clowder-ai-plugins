import { expandSection } from './expand-section.mjs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

/** Only the authenticated session is a fixture. HTML, assets, coordination and
 * team operations all cross the existing real Host forwarding/owner routes. */
export async function verifyInstalledHostBrowser({ root, sender, analysis, inboxId }) {
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const response = await sender.app.inject({ method: req.method, url: req.url,
      headers: { host: 'localhost', origin: 'http://localhost', 'x-test-session': 'owner',
        ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
        ...(req.headers['x-cat-cafe-owner-confirmed'] ? { 'x-cat-cafe-owner-confirmed': req.headers['x-cat-cafe-owner-confirmed'] } : {}) },
      ...(body ? { payload: body } : {}) });
    res.writeHead(response.statusCode, response.headers); res.end(response.rawPayload);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port + '/api/plugins/dev.clowder.issue-workbench/workbench/installed.html');
    if (inboxId) {
      await page.getByRole('button', { name: '团队记录', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '团队记录' });
      await dialog.getByRole('button', { name: /fixture\/repo#1/ }).click();
      await dialog.getByRole('button', { name: '接下此任务', exact: true }).click();
      await dialog.getByLabel('开工指令', { exact: true }).waitFor();
      assert.match(await dialog.getByLabel('开工指令', { exact: true }).inputValue(), new RegExp(inboxId));
      assert.match(await dialog.getByRole('link', { name: '打开收件对话' }).getAttribute('href'), /\/thread\//);
      await page.reload();
      await page.getByRole('button', { name: '团队记录', exact: true }).click();
      await dialog.getByRole('button', { name: /fixture\/repo#1/ }).click();
      await dialog.getByText('你已接下任务。开工与处理进度以收件对话为准。', { exact: true }).waitFor();
      await page.screenshot({ path: join(root, 'host-receiver-browser.png'), fullPage: true });
      assert.deepEqual(errors, []); return;
    }
    await page.getByRole('region', { name: '团队研判' }).getByText('GitHub 组织：fixture-org · 2 位成员', { exact: true }).waitFor();
    await expandSection(page, '补充分析（可选）');
    await page.getByText('讨论 · 已读取 1 条', { exact: true }).waitFor();
    await page.getByLabel('分析备注', { exact: true }).fill('Isolated Host integration: keep this owner-authored plan.');
    await page.getByLabel('问题类别选择', { exact: true }).selectOption('代码与交付');
    const saved = page.waitForResponse(response => response.url().endsWith('/coordination') && response.request().postData()?.includes('saveWork'));
    await page.getByRole('button', { name: '保存分析', exact: true }).click();
    assert.ok((await saved).ok());
    await page.reload();
    await expandSection(page, '补充分析（可选）');
    assert.equal(await page.getByLabel('分析备注', { exact: true }).inputValue(), 'Isolated Host integration: keep this owner-authored plan.');
    assert.equal(await page.getByLabel('问题类别选择', { exact: true }).inputValue(), '代码与交付');
    const wakes = sender.wakes.length;
    await page.getByRole('group', { name: '研判方式', exact: true }).getByRole('button', { name: '猫猫研判', exact: true }).click();
    await page.getByRole('button', { name: '请猫分析', exact: true }).click();
    await page.getByText('已发送，等待研判', { exact: true }).waitFor();
    assert.equal(sender.wakes.length, wakes + 1);
    const job = (await sender.action('summary', { kind: 'analysis' })).rows.find(row => !row.analysis);
    assert.ok(job, 'browser request persisted in real Host storage');
    await sender.native('submit', { id: job.id, analysis });
    await page.getByText('9 / 10', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('问题类别选择', { exact: true }).inputValue(), '代码与交付', 'cat result cannot overwrite human classification');
    await page.getByText('当前分类：代码与交付', { exact: true }).waitFor();
    await expandSection(page, '人工修改历史');
    await page.getByRole('button', { name: '读取修改历史', exact: true }).click();
    await page.getByRole('heading', { name: '版本 1 · 代码与交付', exact: true }).waitFor();
    await page.screenshot({ path: join(root, 'host-browser.png'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  }
}

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createConnection } from '../src/connections.mjs';
import { Receiver } from '../src/engine.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { openStage } from './journey-controls.mjs';
import { launchOwnedBrowser } from './owned-browser.mjs';
import { versionRepositories } from './version-fixtures.mjs';

const f = await versionRepositories();
const external = 'https://github.com/demo/core.git';
const internal = 'ssh://git@ssh.codehub.example:2222/team/core.git';
const folder = await fs.mkdtemp(join(tmpdir(), 'repo-sync-recovery-web-'));
const file = join(folder, 'config.json');
const evidence = process.env.REPO_SYNC_EVIDENCE || join(tmpdir(), 'repo-sync-recovery-evidence');
await fs.mkdir(evidence, { recursive: true });
const environment = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: `url.${f.source.replaceAll('\\', '/')}.insteadOf`,
  GIT_CONFIG_VALUE_0: external,
  GIT_CONFIG_KEY_1: `url.${f.internal.replaceAll('\\', '/')}.insteadOf`,
  GIT_CONFIG_VALUE_1: internal,
};
const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
Object.assign(process.env, environment);
const config = {
  ...f.config,
  allowLocal: false,
  sourceUrl: external,
  internalUrl: internal,
  stateDir: join(folder, 'state'),
};
await fs.writeFile(file, JSON.stringify(config));
const receiver = new Receiver(config);
await receiver.adopt(f.u0, f.i0);
await receiver.selectTag('v2.0.0');
await receiver.start();
await receiver.prepare();
const initial = await receiver.status();
const connection = await createConnection(file);
const server = createReceiverServer(null, { connection });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const { browser, close: closeBrowser } = await launchOwnedBrowser(chromium, {
  headless: true,
  executablePath: process.env.REPO_SYNC_CHROME,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const rename = fs.rename;
let denied = false;
fs.rename = async (from, to) => {
  if (denied && to === receiver.store.path)
    throw Object.assign(new Error('private file and original error'), {
      code: 'EPERM',
    });
  return rename(from, to);
};
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const prStage = page.locator('[data-stage="3"]');
  if (!(await prStage.evaluate((element) => element.open))) await openStage(page, await prStage.getAttribute('data-stage'));
  await page.getByRole('heading', { name: '先配置内部仓库网页地址', level: 3 }).waitFor();
  await page.getByRole('link', { name: '配置网页地址，继续 PR →' }).waitFor();
  assert.equal(await page.locator('[data-form="pr"]').count(), 0);
  const settings = page.locator('[data-form="configure-pr"]');
  assert.equal(await settings.getByLabel('PR 创建方式').inputValue(), 'manual');
  await page.screenshot({
    path: join(evidence, 'missing-web-origin.png'),
    fullPage: true,
  });
  await settings.getByLabel('用于确认 PR 地址的内部网页仓库').fill('https://web.codehub.example/team/core');
  await settings.getByRole('button', { name: '保存 PR 创建设置' }).click();
  await page.locator('[data-form="pr"]').waitFor();
  assert.deepEqual((await receiver.status()).accepted, initial.accepted);
  const url = 'https://web.codehub.example/team/core/merge_requests/501';
  await page.getByLabel('内部 PR 具体链接').fill(url);
  await page.locator('[data-pr-confirm]').check();
  await page.getByRole('button', { name: '登记 PR，进入审核' }).click();
  await page.getByRole('link', { name: '打开内部 PR ↗', exact: true }).waitFor({ timeout: 20000 });
  assert.equal((await receiver.status()).active.prUrl, url);
  if (!(await page.locator('[data-stage="3"]').evaluate((element) => element.open)))
    await openStage(page, 3);
  await page.getByText('链接填错了？纠正或撤销引用').click();
  denied = true;
  await page.locator('[data-form="clear-pr"] input[type="checkbox"]').check();
  await page.getByRole('button', { name: '撤销错误引用，返回 PR 创建步骤' }).click();
  await page.locator('#error').filter({ hasText: 'LEDGER_WRITE_FAILED' }).waitFor({ timeout: 20000 });
  assert.equal((await receiver.status()).active.prUrl, url);
  await page.reload();
  const reopenedPrStage = page.locator('[data-stage="3"]');
  if (!(await reopenedPrStage.evaluate((element) => element.open)))
    await openStage(page, await reopenedPrStage.getAttribute('data-stage'));
  const failedReference = page.locator(
    '[data-stage="3"] [data-step-key="platform-pr"][data-step-state="failed"]',
  );
  await failedReference.waitFor();
  const ledgerEvidence = failedReference
    .locator('[data-attempt]')
    .filter({ hasText: '保存交付台账' })
    .filter({ hasText: 'LEDGER_WRITE_FAILED' });
  await ledgerEvidence.locator(':scope > summary').click();
  await ledgerEvidence.getByText(/LEDGER_WRITE_FAILED/).waitFor();
  await failedReference.getByText('错误码与脱敏诊断摘要', { exact: true }).click();
  await failedReference
    .getByText(/LEDGER_WRITE_FAILED/)
    .first()
    .waitFor();
  assert.doesNotMatch(await failedReference.innerText(), /private file and original error/);
  await page.setViewportSize({ width: 390, height: 1050 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(evidence, 'ledger-save-failed-mobile.png'),
    fullPage: true,
  });
  denied = false;
  if (!(await page.locator('[data-stage="3"]').evaluate((element) => element.open)))
    await openStage(page, 3);
  const correction = page.getByText('链接填错了？纠正或撤销引用');
  if (!(await correction.evaluate((element) => element.closest('details').open))) await correction.click();
  await page.locator('[data-form="clear-pr"] input[type="checkbox"]').check();
  await page.getByRole('button', { name: '撤销错误引用，返回 PR 创建步骤' }).click();
  await page.getByRole('button', { name: '登记 PR，进入审核' }).waitFor({ timeout: 20000 });
  assert.equal((await receiver.status()).active.candidate, initial.active.candidate);
  assert.equal((await receiver.status()).active.prHistory.length, 1);
  await page.getByLabel('内部 PR 具体链接').fill(url);
  await page.locator('[data-pr-confirm]').check();
  await page.getByRole('button', { name: '登记 PR，进入审核' }).click();
  await page.getByRole('link', { name: '打开内部 PR ↗', exact: true }).waitFor({ timeout: 20000 });
  await f.merge((await receiver.status()).active);
  await page.getByRole('button', { name: '已在平台合入，核验 Git 结果' }).click();
  await page.getByRole('heading', { name: '当前已接收版本' }).waitFor({ timeout: 20000 });
  assert.equal((await receiver.status()).accepted.tag, 'v2.0.0');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: SSH:2222 to independent HTTPS origin; inline settings preserve baseline/candidate; durable write error and failed phase survive refresh; safe withdrawal retry; real Git merge; mobile.',
  );
} catch (error) {
  console.log('Browser errors:', errors, '\nVisible page:', await page.locator('body').innerText());
  await page.screenshot({
    path: join(evidence, 'failure.png'),
    fullPage: true,
  });
  throw error;
} finally {
  fs.rename = rename;
  await page.close();
  await closeBrowser();
  await server.shutdown();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

import { launchOwnedBrowser } from './owned-browser.mjs';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createConnection } from '../src/connections.mjs';
import { phase } from '../src/execution.mjs';
import { command } from '../src/process.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { activateBaseline } from './setup-journey-helpers.mjs';
import { versionRepositories } from './version-fixtures.mjs';

const f = await versionRepositories();
const folder = await mkdtemp(join(tmpdir(), 'repo-sync-browser-recovery-'));
const configFile = join(folder, 'config.json');
await writeFile(configFile, JSON.stringify({ ...f.config, stateDir: join(folder, 'state') }));
const connection = await createConnection(configFile);
const receiver = await connection.current();
const heads = receiver.git.heads.bind(receiver.git);
const fetchObjects = receiver.git.fetch.bind(receiver.git);
let sshFailure = true;
receiver.git.heads = async () => {
  if (!sshFailure) return heads();
  await phase('source-probe', '检查外部连接与分支', async () => null);
  await phase('internal-probe', '检查内部连接与分支', () =>
    command(process.execPath, [
      '-e',
      'process.stderr.write("Host key verification failed. private-host fixture-secret\\n");process.exit(128)',
    ]),
  );
};
const server = createReceiverServer(receiver, { connection });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const { browser, close: closeBrowser } = await launchOwnedBrowser(chromium, {
  headless: true,
  ...(process.env.REPO_SYNC_CHROME ? { executablePath: process.env.REPO_SYNC_CHROME } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const evidence = process.env.REPO_SYNC_EVIDENCE || join(tmpdir(), 'repo-sync-connection-evidence');
await mkdir(evidence, { recursive: true });
try {
  await page.goto(base);
  await page.getByRole('button', { name: '配置同步基线 →' }).click();
  await page.getByRole('button', { name: '读取两侧当前版本' }).click();
  await page.locator('#operation [data-operation-state="FAILED"]').filter({ hasText: 'SSH_HOST_KEY_FAILED' }).waitFor();
  assert.equal(await page.locator('#operation [data-operation-state="DONE"]').count(), 1);
  assert.doesNotMatch(await page.locator('#operation').innerText(), /private-host|fixture-secret/);
  await page.locator('#operation').screenshot({ path: join(evidence, 'connection-host-key-failed.png') });
  sshFailure = false;
  let headsRequests = 0;
  let dropped = false;
  await page.route('**/api/tasks', async (route) => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().action === 'heads') {
      headsRequests++;
      if (!dropped) {
        dropped = true;
        await route.fetch();
        await route.abort('failed');
        return;
      }
    }
    await route.continue();
  });
  await page.getByRole('button', { name: '重新检查两侧连接' }).click();
  await page.locator('#observed-heads').filter({ hasText: '读取成功' }).waitFor({ timeout: 20000 });
  assert.equal(headsRequests, 1, 'lost startup response queries the original task without resubmitting');
  await assert.rejects(access(receiver.git.directory), { code: 'ENOENT' });
  receiver.git.fetch = async () => {
    await heads();
    await phase('object-store', '准备私有对象目录', async () => null);
    await phase('source-fetch', '下载外部对象', () =>
      command(process.execPath, [
        '-e',
        'process.stderr.write("Receiving obj");setTimeout(()=>process.stderr.write("ects: 40% (2/5)\\rprivate fixture-secret\\n"),80);setInterval(()=>{},1000);',
      ]),
    );
  };
  await page.getByLabel('上次已经接收的外部版本').fill(f.u0);
  await page.getByRole('button', { name: '核验起点并查看文件 →' }).click();
  await page
    .locator('#operation')
    .getByText(/接收对象 40%/)
    .waitFor();
  assert.equal(await page.getByRole('button', { name: '同步工作台', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: '核验起点并查看文件 →' }).isEnabled(), false);
  const original = (await (await fetch(`${base}/api/status`)).json()).operation.id;
  await page.locator('#operation').screenshot({ path: join(evidence, 'connection-download-progress.png') });
  await page.reload();
  await page
    .locator('#operation')
    .getByText(/接收对象 40%/)
    .waitFor();
  assert.equal((await (await fetch(`${base}/api/status`)).json()).operation.id, original);
  await page.getByRole('button', { name: '取消当前读取 / 下载' }).click();
  await page.locator('#operation .badge').filter({ hasText: '已取消' }).waitFor({ timeout: 15000 });
  assert.equal(await receiver.status(), null, 'cancelled download has not registered the baseline');
  const cancelled = (await (await fetch(`${base}/api/status`)).json()).operation;
  assert.equal(cancelled.status, 'CANCELLED');
  assert.doesNotMatch(JSON.stringify(cancelled), /fixture-secret|private-host/);
  assert.equal(await page.getByRole('button', { name: '核验起点并查看文件 →' }).isEnabled(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('#operation').screenshot({ path: join(evidence, 'connection-cancelled-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1100 });
  receiver.git.fetch = fetchObjects;
  await page.getByLabel('上次已经接收的外部版本').fill(f.u0);
  await page.getByLabel('内部当前接收位置').fill(f.i0);
  await page.getByRole('button', { name: '核验起点并查看文件 →' }).click();
  await page.getByRole('button', { name: '继续确认启用 →' }).waitFor({ timeout: 30000 });
  await activateBaseline(page, receiver);
  assert.equal((await receiver.status()).accepted.upstream, f.u0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS：SSH 原因与 × → 回执丢失查询原任务 → 真实轻量 HEAD → 分块进度 → 刷新续看 → 取消下载无基线 → 重试实际 Git 核验。',
  );
} finally {
  await closeBrowser();
  await server.shutdown();
}

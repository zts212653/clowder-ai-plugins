import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Receiver } from '../src/engine.mjs';
import { setGithubToken } from '../src/github-auth.mjs';
import { setIssueToken } from '../src/issue-auth.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { readTask } from '../src/task-store.mjs';
import { codehubPlatform } from './codehub-fixture.mjs';
import { developmentFixture } from './development-history-fixture.mjs';
import { openAutoMerge, openHistory } from './journey-controls.mjs';
import { launchOwnedBrowser } from './owned-browser.mjs';

const f = await developmentFixture(),
  platform = await codehubPlatform(f);
const adapter = {
  mode: 'gitlab',
  apiUrl: platform.api,
  projectId: 'team/core',
  authMode: 'session',
};
const receiver = new Receiver({
  ...f.config,
  internalWebUrl: platform.web,
  issues: adapter,
  pullRequests: { ...adapter },
});
receiver.git.config = { ...receiver.config, sourceUrl: f.source };
setIssueToken(receiver.config, platform.token, 'browser-fixture');
setGithubToken(receiver.config, 'synthetic-github-token', 'browser-fixture');
f.provider.collectIssues = async () => [
  {
    sourceId: 'issue-7',
    number: 7,
    title: '修复站点读取',
    body: '',
    url: 'https://github.com/demo/core/issues/7',
    relation: 'closes',
  },
  {
    sourceId: 'issue-8',
    number: 8,
    title: '文档入口关联',
    body: '',
    url: 'https://github.com/demo/core/issues/8',
    relation: 'related',
  },
];
const server = createReceiverServer(receiver, {
  sourceProvider: f.provider,
  syncInterval: 3600000,
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const folder = await mkdtemp(join(tmpdir(), 'repo-sync-development-retry-'));
const evidence = join(folder, 'evidence');
await mkdir(evidence);
const { browser, close: closeBrowser } = await launchOwnedBrowser(chromium, {
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
page.setDefaultTimeout(20000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
async function waitState(predicate) {
  let last;
  for (let i = 0; i < 1500; i++) {
    const state = await receiver.status();
    last = state;
    if (predicate(state)) return state;
    if (state.automation?.status === 'FAILED')
      throw Error(
        JSON.stringify({
          error: state.automation.error,
          fixture: platform.state.errors,
        }),
      );
    await new Promise((done) => setTimeout(done, 100));
  }
  throw Error(
    JSON.stringify({
      error: 'Development/retry journey did not settle',
      automation: last?.automation?.status,
      active: last?.active?.status,
      deliveryId: last?.active?.id,
      latestTask: await readTask(receiver.config),
      fixture: platform.state.errors,
    }),
  );
}
async function waitTask(action, expectedStatus) {
  for (let i = 0; i < 1500; i++) {
    const task = await readTask(receiver.config);
    if (task?.action === action && (!expectedStatus || task.status === expectedStatus)) return task;
    if (task?.action === action && ['FAILED', 'CANCELLED', 'INTERRUPTED'].includes(task.status))
      throw Error(JSON.stringify({ action, status: task.status, error: task.error }));
    await new Promise((done) => setTimeout(done, 100));
  }
  throw Error(`Timed out waiting for ${action} task ${expectedStatus ?? 'to finish'}`);
}
try {
  await page.goto(base);
  await page.getByRole('button', { name: '开始同步 →', exact: true }).click();
  let state = await waitState(
    (s) => s.active?.status === 'WAITING_APPROVAL' && s.automation?.status === 'WAITING_REVIEW',
  );
  await waitTask('synchronize', 'SUCCEEDED');
  const original = state.active;
  await page
    .locator('[data-delivery-overview] .delivery-metrics dd')
    .filter({ hasText: /^18$/ })
    .first()
    .waitFor({ timeout: 150000 });
  const overview = page.locator('[data-delivery-overview]');
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-delivery-overview] .delivery-metrics dd')]
        .map((e) => e.textContent)
        .join('|') === '18|1|18|2',
  );
  assert.deepEqual(await overview.locator('.delivery-metrics dd').allTextContents(), ['18', '1', '18', '2']);
  await overview.locator('.delivery-object-details').first().locator(':scope > summary').click();
  assert.equal(
    await overview.getByRole('link', { name: '#7 修复站点读取', exact: true }).getAttribute('href'),
    'https://github.com/demo/core/issues/7',
  );
  assert.equal(await overview.getByRole('link', { name: '内部 #1', exact: true }).isVisible(), true);
  assert.equal(await overview.getByText('文档入口关联', { exact: false }).isVisible(), true);
  await overview.locator('.delivery-object-details').nth(1).locator(':scope > summary').click();
  assert.equal(await overview.locator('.delivery-object-details').nth(1).locator('li').count(), 18);
  await page.screenshot({
    path: join(evidence, 'development-overview-1440.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await openHistory(page);
  await page.locator('[data-record="current"]').click();
  await overview.waitFor({ state: 'visible' });
  assert.equal(await overview.isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({
    path: join(evidence, 'development-overview-390.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await overview.locator('.delivery-more > summary').click();
  await overview.locator('.delivery-cancel > summary').click();
  let form = page.locator('[data-form="cancel-delivery"]');
  await form.getByRole('button').click();
  assert.equal(platform.state.prCloses, 0, 'confirmation is required');
  await form.getByRole('checkbox').check();
  await form.getByRole('checkbox').blur();
  for (let i = 0; i < 3; i++) {
    await page.waitForResponse((response) => response.url().includes('/api/status') && response.ok());
    assert.equal(await form.getByRole('checkbox').isChecked(), true, 'polling must preserve same-PR consent');
  }
  await page.reload();
  for (const selector of ['.delivery-more', '.delivery-cancel'])
    if (!(await page.locator(selector).evaluate((node) => node.open)))
      await page.locator(`${selector} > summary`).click();
  form = page.locator('[data-form="cancel-delivery"]');
  assert.equal(
    await form.getByRole('checkbox').isChecked(),
    false,
    'refresh requires explicit confirmation again',
  );
  platform.state.lost = 'pr-close';
  await form.getByRole('checkbox').check();
  await form.getByRole('button').click();
  await waitState(
    (s) => s.active?.cancellation?.status === 'REQUESTED' && s.active.error?.code === 'PR_API_UNAVAILABLE',
  );
  const failedCancellation = await waitTask('cancel-delivery', 'FAILED');
  assert.equal(failedCancellation.error.code, 'PR_API_UNAVAILABLE');
  await page.reload();
  if (!(await page.locator('.delivery-more').evaluate((node) => node.open)))
    await page.locator('.delivery-more > summary').click();
  form = page.locator('[data-form="cancel-delivery"]');
  await form.getByRole('button', { name: '回读并完成原 PR 撤销', exact: true }).waitFor();
  assert.equal(await form.getByRole('checkbox').isChecked(), false);
  await form.getByRole('checkbox').check();
  await form.getByRole('button').click();
  state = await waitState((s) => !s.active && s.automation.status === 'PAUSED');
  await waitTask('cancel-delivery', 'SUCCEEDED');
  assert.equal(platform.state.prCloses, 1);
  assert.equal(platform.state.creates.prs, 1);
  assert.equal(state.accepted.upstream, f.u2);
  await page.reload();
  await page.getByRole('button', { name: '重新读取目标并同步本笔 →', exact: true }).waitFor();
  assert.notEqual(await page.locator('[data-flow-stage="4"]').getAttribute('data-flow-state'), 'done');
  await page.locator('.cancelled-notice [data-record]').click();
  await page.waitForFunction(
    () => document.querySelector('[data-flow-stage="4"]')?.dataset.flowState === 'cancelled',
  );
  await page.locator('[data-flow-stage-select="4"]').click();
  assert.equal(
    await page
      .locator('[data-stage="4"] [data-step-key="merge-observe"]')
      .getAttribute('data-operation-state'),
    'SKIPPED',
  );
  await openHistory(page);
  await page.getByRole('button', { name: '返回当前同步', exact: true }).click();
  await page.getByRole('button', { name: '重新读取目标并同步本笔 →', exact: true }).click();
  state = await waitState(
    (s) => s.active?.status === 'WAITING_APPROVAL' && s.automation?.status === 'WAITING_REVIEW',
  );
  await waitTask('resume-sync', 'SUCCEEDED');
  const replacement = state.active;
  assert.notEqual(replacement.id, original.id);
  assert.equal(replacement.supersedes, original.id);
  assert.equal(replacement.internalCommitCount, 18);
  assert.equal(platform.state.creates.issues, 2);
  assert.equal(platform.state.creates.prs, 2);
  const autoMerge = page.locator('[data-form="configure-auto-merge"]');
  assert.equal(await autoMerge.locator('[name="autoMerge"]').isChecked(), false);
  const reviewLink = page.getByRole('link', {
    name: '打开内部 PR ↗',
    exact: true,
  });
  await reviewLink.waitFor();
  assert.equal(
    await reviewLink.getAttribute('href'),
    replacement.prUrl,
    'the primary review action opens the concrete internal PR',
  );
  await openAutoMerge(page);
  await autoMerge.locator('[name="autoMerge"]').check();
  await autoMerge.getByRole('button', { name: '保存自动合入选择' }).click();
  await waitState((s) => s.automation.autoMerge === true);
  assert.equal((await receiver.status()).automation.autoMerge, true);
  state = await waitState((s) => !s.active && s.automation.status === 'COMPLETE');
  await waitTask('resume-sync', 'SUCCEEDED');
  assert.equal(
    platform.state.merges,
    1,
    'saving opt-in while waiting on a checked PR immediately starts platform merge',
  );
  assert.equal(platform.state.creates.prs, 2);
  assert.equal(
    platform.state.issues[1].state,
    'opened',
    'shared Issue stays open until all mapped targets are accepted',
  );
  assert.equal(platform.state.creates.issues, 2);
  assert.equal(state.deliveries.at(-1).supersedes, original.id);
  assert.equal(await receiver.git.remoteBranch(original.branch), original.candidate);
  await page.reload();
  await openHistory(page);
  await page.locator(`.history-disclosure [data-record="${original.id}"]`).click();
  await page.locator('[data-delivery-overview]').waitFor();
  assert.equal(
    await page.locator('[data-form="cancel-delivery"]').count(),
    0,
    'history cannot close a live PR',
  );
  assert.equal(await page.locator('[data-flow-stage="4"]').getAttribute('data-flow-state'), 'cancelled');
  assert.equal(platform.state.closes, 1);
  assert.equal(platform.state.issues[1].state, 'opened');
  assert.deepEqual(errors, []);
  console.log(`Development/retry browser passed; evidence ${evidence}`);
} catch (error) {
  console.error(error.message);
  await page.screenshot({
    path: join(evidence, 'failure.png'),
    fullPage: true,
  });
  console.error(`Browser evidence ${evidence}`);
  throw error;
} finally {
  await closeBrowser();
  await server.shutdown();
  await platform.close();
}

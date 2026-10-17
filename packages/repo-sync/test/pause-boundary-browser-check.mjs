import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createConnection } from '../src/connections.mjs';
import { execution } from '../src/execution.mjs';
import { git } from '../src/process.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { codehubPlatform } from './codehub-fixture.mjs';
import { continuousRepositories } from './continuous-fixtures.mjs';
import { openStage } from './journey-controls.mjs';
import { gate, until } from './journey-gates.mjs';
import { launchOwnedBrowser } from './owned-browser.mjs';

const f = await continuousRepositories(),
  platform = await codehubPlatform(f);
await writeFile(join(f.source, 'core.txt'), 'third direct delivery');
await git(f.source, ['add', 'core.txt']);
await git(f.source, ['commit', '-m', 'third direct delivery without a PR']);
const third = await git(f.source, ['rev-parse', 'HEAD']);
const plans = f.plans.map((plan, index) => ({
  ...plan,
  issues: [
    {
      ...plan.issues[0],
      sourceId: `issue-${71 + index}`,
      number: 71 + index,
      url: `https://github.com/demo/core/issues/${71 + index}`,
      requiredTargets: [plan.target],
    },
  ],
}));
plans.push({
  target: third,
  issues: [],
  source: {
    id: `commit:${third}`,
    kind: 'commit',
    commit: third,
    title: '第三笔主干直接提交',
    url: `https://github.com/demo/core/commit/${third}`,
  },
});
const folder = await mkdtemp(join(tmpdir(), 'repo-sync-pause-boundary-'));
const file = join(folder, 'config.json'),
  evidence = process.env.REPO_SYNC_EVIDENCE || join(folder, 'evidence');
await mkdir(evidence, { recursive: true });
const tokenName = 'REPO_SYNC_PAUSE_BOUNDARY_TOKEN',
  previousToken = process.env[tokenName];
process.env[tokenName] = platform.token;
const api = {
  mode: 'gitlab',
  apiUrl: platform.api,
  projectId: 'innersource/team_G/core',
  tokenEnv: tokenName,
};
await writeFile(
  file,
  JSON.stringify({
    ...f.config,
    internalWebUrl: platform.web,
    pullRequests: api,
    issues: api,
  }),
);
let connection = await createConnection(file),
  receiver = await connection.current();
await receiver.adopt(f.u0, f.i0);
await receiver.setQueue(plans);
const preparation = gate('prepare'),
  fetchGate = gate('post-merge readback'),
  verification = gate('merge verification');
const originalPrepare = receiver.prepare.bind(receiver),
  originalFetch = receiver.git.fetch.bind(receiver.git);
const originalVerify = receiver.git.verify.bind(receiver.git);
let postMerge = false,
  fetched = false,
  verified = false;
receiver.prepare = async (...args) => {
  await preparation.wait();
  return originalPrepare(...args);
};
receiver.git.fetch = async (...args) => {
  if (postMerge && !fetched && execution()?.action === 'resume-sync') {
    fetched = true;
    await fetchGate.wait();
  }
  return originalFetch(...args);
};
receiver.git.verify = async (...args) => {
  if (!verified) {
    verified = true;
    await verification.wait();
  }
  return originalVerify(...args);
};
let server = createReceiverServer(null, { connection, syncInterval: 100 });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const { browser, close: closeBrowser } = await launchOwnedBrowser(chromium, {
  host: '127.0.0.1',
  headless: true,
  executablePath: process.env.REPO_SYNC_CHROME,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }),
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const steps = () =>
  page
    .locator('[data-stage]')
    .evaluateAll((stages) =>
      stages.flatMap((stage) =>
        [
          ...stage.querySelectorAll(
            ':scope > .stage-body > [data-attempts-stage] > .substeps > [data-step-key]',
          ),
        ].map((step) => `${stage.dataset.stage}:${step.dataset.stepKey}`),
      ),
    );
async function fifthStage(expectedOpen = false) {
  await page.locator('[data-flow-stage="5"][data-flow-state="current"]').waitFor({ timeout: 30000 });
  assert.notEqual(await page.locator('[data-stage="2"]').getAttribute('data-stage-state'), 'current');
  assert.equal(await page.locator('[data-stage="2"]').evaluate((node) => node.open), false);
  assert.equal(await page.locator('[data-stage="5"]').evaluate((node) => node.open), expectedOpen);
}
async function paused(completed, expectedStageOpen = false) {
  const state = await until(
    () => receiver.status(),
    (current) => current.automation?.status === 'PAUSED',
    `must pause after delivery ${completed}`,
  );
  assert.equal(state.automation.continuation, 'after-each');
  assert.equal(state.active, undefined, 'no unfinished delivery exists at the accepted boundary');
  assert.equal(state.deliveries.length, completed, 'the next delivery must not even be started');
  assert.equal(state.queue.length, 3 - completed);
  assert.equal(state.deliveries[completed - 1].status, 'COMPLETE');
  assert.equal(await page.locator('[data-stage="5"]').evaluate((node) => node.open), expectedStageOpen);
  assert.ok(state.deliveries[completed - 1].acceptedInternal);
  assert.equal(platform.state.creates.prs, completed);
  assert.equal(platform.state.creates.issues, completed);
  assert.equal(
    platform.state.issues[completed - 1].state,
    'closed',
    'Issue closure belongs to the completed delivery',
  );
  await page.getByRole('button', { name: '继续下一笔同步 →', exact: true }).waitFor({ timeout: 30000 });
  await new Promise((done) => setTimeout(done, 700));
  assert.equal(
    (await receiver.status()).deliveries.length,
    completed,
    'background observation cannot cross the boundary',
  );
  return state;
}
async function merge(delivery, number) {
  await f.merge(delivery);
  platform.state.mrs[number - 1].state = 'merged';
}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button', { name: '同步上游 PR #1 →', exact: true }).click();
  await preparation.entered();
  await page.locator('[data-stage="5"] [data-step-key="merge-verify"]').waitFor({ state: 'attached' });
  const planned = await steps();
  assert.equal(new Set(planned).size, planned.length, 'each business substep has one row');
  for (const stage of [1, 2, 3, 4, 5]) assert.ok(planned.some((key) => key.startsWith(`${stage}:`)));
  assert.ok(planned.includes('5:issue-state'), 'Issue verification must be visible before execution');
  preparation.release();
  await page.getByRole('link', { name: '打开内部 PR ↗', exact: true }).waitFor({ timeout: 30000 });
  assert.deepEqual(await steps(), planned, 'execution must not add new top-level business substeps');
  const first = (await receiver.status()).active;
  assert.equal(platform.state.creates.prs, 1);
  assert.equal(platform.state.creates.issues, 1);
  const pauseButton = page.getByRole('button', {
    name: '本笔完成后暂停',
    exact: true,
  });
  assert.equal(
    await pauseButton.isVisible(),
    true,
    'the pause action must be visible without opening settings',
  );
  await pauseButton.click();
  await until(
    () => receiver.status(),
    (current) => Boolean(current.automation?.pauseRequested),
    'pause intent saved',
  );
  await page.reload();
  await page.getByText(/已设置：本笔完成后暂停/).waitFor();
  await page.locator('.next-action .run-options > details:not(.auto-merge-options) > summary').click();
  const continuation = page.locator('form[data-form="configure-continuation"]');
  await continuation.locator('[name="continuation"]').selectOption('after-each');
  await continuation.getByRole('button').click();
  const configured = await until(
    () => receiver.status(),
    (current) => current.automation?.continuation === 'after-each',
    'save the continuing after-each policy',
  );
  assert.equal(
    configured.automation.status,
    'WAITING_REVIEW',
    'still observe and finish the PR already in review',
  );
  const runId = configured.automation.id;
  const firstStage = page.locator('[data-stage="1"]');
  assert.equal(await firstStage.evaluate((node) => node.open), false);
  await openStage(page, await firstStage.getAttribute('data-stage'));
  await page.waitForTimeout(5500);
  assert.equal(
    await firstStage.evaluate((node) => node.open),
    true,
    'manual expansion survives background polling',
  );
  postMerge = true;
  await merge(first, 1);
  await fetchGate.entered();
  await fifthStage();
  assert.equal(await firstStage.evaluate((node) => node.open), true);
  assert.deepEqual(await steps(), planned);
  const mergeStage = page.locator('[data-stage="5"]');
  await openStage(page, await mergeStage.getAttribute('data-stage'));
  fetchGate.release();
  await verification.entered();
  await page.locator('[data-stage="5"] [data-step-key="merge-verify"][data-step-state="current"]').waitFor();
  await fifthStage(true);
  assert.deepEqual(await steps(), planned, 'merge verification must use the same fixed workflow');
  await page.screenshot({
    path: join(evidence, 'merge-verification-fifth-stage.png'),
    fullPage: true,
  });
  verification.release();
  const boundary = await paused(1, true);
  assert.equal(boundary.accepted.upstream, f.u1);
  await page.reload();
  await page.getByRole('button', { name: '继续下一笔同步 →', exact: true }).waitFor();
  assert.equal((await receiver.status()).automation.id, runId);
  await page.goto('about:blank');
  await server.shutdown();
  connection = await createConnection(file);
  receiver = await connection.current();
  server = createReceiverServer(null, { connection, syncInterval: 100 });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await paused(1);
  assert.equal((await receiver.status()).automation.id, runId, 'restart resumes the same paused round');
  await page.getByRole('button', { name: '继续下一笔同步 →', exact: true }).click();
  await until(
    () => receiver.status(),
    (current) => current.active?.source.number === 2 && Boolean(current.active.prUrl),
    'explicit continue starts exactly PR 2',
  );
  await page.locator('[data-round-current]').filter({ hasText: 'PR #2' }).waitFor({ timeout: 30000 });
  assert.equal(
    await page.locator('[data-stage="1"]').evaluate((node) => node.open),
    false,
    'manual expansion must not leak from PR 1 to PR 2',
  );
  assert.equal(await page.locator('[data-stage="5"]').evaluate((node) => node.open), false);
  const second = (await receiver.status()).active;
  assert.equal((await receiver.status()).automation.continuation, 'after-each');
  await merge(second, 2);
  const again = await paused(2);
  assert.equal(again.accepted.upstream, f.u2);
  assert.equal(again.queue[0].source.kind, 'commit');
  await page.getByRole('button', { name: '继续下一笔同步 →', exact: true }).click();
  const finalReview = await until(
    () => receiver.status(),
    (current) => current.active?.target === third && Boolean(current.active.prUrl),
    'explicit continue starts the direct-commit delivery',
  );
  assert.equal(platform.state.creates.prs, 3);
  assert.equal(
    platform.state.creates.issues,
    2,
    'a direct commit without Issues must not create a fake Issue',
  );
  await merge(finalReview.active, 3);
  const final = await until(
    () => receiver.status(),
    (current) => current.automation?.status === 'COMPLETE',
    'complete the frozen target',
  );
  assert.equal(final.accepted.upstream, third);
  assert.equal(final.deliveries.length, 3);
  assert.ok(final.deliveries.every((delivery) => delivery.status === 'COMPLETE'));
  assert.equal(final.queue.length, 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: fixed visible substeps; merge readback and verification stay in stage 5; per-delivery expansion; continuous after-each policy; Issue closure before pause; refresh/restart preserve the boundary; explicit continuation alone starts each next PR; real Git PR/Issue/direct-commit reception.',
  );
} catch (error) {
  await page
    .screenshot({
      path: join(evidence, 'pause-boundary-failure.png'),
      fullPage: true,
    })
    .catch(() => {});
  console.error(
    'Page errors:',
    errors,
    '\nStage states:',
    await page
      .locator('[data-stage]')
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          stage: node.dataset.stage,
          state: node.dataset.stageState,
          open: node.open,
        })),
      )
      .catch(() => []),
  );
  throw error;
} finally {
  preparation.release();
  fetchGate.release();
  verification.release();
  try {
    await closeBrowser();
  } finally {
    await server.shutdown();
    await platform.close();
    if (previousToken === undefined) delete process.env[tokenName];
    else process.env[tokenName] = previousToken;
  }
}

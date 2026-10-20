import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Receiver } from '../src/engine.mjs';
import { git } from '../src/process.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { continuousRepositories } from './continuous-fixtures.mjs';
import { issuePlatform } from './issue-fixtures.mjs';
import { openHistory } from './journey-controls.mjs';
import { launchOwnedBrowser } from './owned-browser.mjs';

const f = await continuousRepositories(),
  platform = await issuePlatform(f);
await git(f.internal, ['config', 'receive.advertisePushOptions', 'true']);
const counter = join(f.root, 'pr-count.json'),
  script = join(f.root, 'pr-hook.mjs');
await writeFile(
  script,
  `import{readFileSync,writeFileSync,existsSync}from'node:fs';
let input='';for await(const c of process.stdin)input+=c;
if(!Array.from({length:Number(process.env.GIT_PUSH_OPTION_COUNT)},(_,i)=>process.env['GIT_PUSH_OPTION_'+i]).includes('merge_request.create'))process.exit(0);
const file=${JSON.stringify(counter)},n=existsSync(file)?JSON.parse(readFileSync(file,'utf8'))+1:1;
writeFileSync(file,JSON.stringify(n));console.log('View PR: https://codehub.example/core/pull/'+n);`,
);
await writeFile(
  join(f.internal, 'hooks', 'post-receive'),
  `#!/bin/sh\nexec "${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"\n`,
  { mode: 0o755 },
);
const receiver = new Receiver({
  ...f.config,
  sourceUrl: 'https://github.com/demo/core.git',
  issues: platform.config,
  commitStrategy: 'rewrite',
  receivingIdentity: { name: 'Internal Sync', email: 'sync@example.invalid' },
  pullRequests: { mode: 'git' },
});
receiver.git.config = { ...receiver.config, sourceUrl: f.source };
await receiver.adopt(f.u0, f.i0);
const prs = f.plans.map((plan) => ({
  node_id: plan.source.id,
  number: plan.source.number,
  html_url: plan.source.url,
  title: plan.source.title,
  merged: true,
  merged_at: '2026-10-14T00:00:00Z',
  merge_commit_sha: plan.target,
  base: { ref: 'releases' },
}));
const sourceProvider = {
  api: async (path) =>
    path === 'repos/demo/core'
      ? { node_id: 'repository' }
      : path.includes('/commits/')
        ? prs.filter((pr) => pr.number === 1 && path.includes(pr.merge_commit_sha))
        : prs.find((pr) => path === `repos/demo/core/pulls/${pr.number}`),
  collectIssues: async (_, pr) => [
    {
      ...f.plans[(pr?.number ?? 2) - 1].issues[0],
      relation: pr?.number === 1 ? 'related' : 'closes',
    },
  ],
};
const server = createReceiverServer(receiver, {
  sourceProvider,
  syncInterval: 100,
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const { browser, close: closeBrowser } = await launchOwnedBrowser(chromium, {
  headless: true,
  executablePath: process.env.REPO_SYNC_CHROME,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const evidence = process.env.REPO_SYNC_EVIDENCE || join(f.root, 'evidence');
await mkdir(evidence, { recursive: true });
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByLabel('目标类型').selectOption('tag');
  await page.getByLabel('目标 tag 名称 / 完整 commit SHA').fill('v2.0.0');
  await page.getByRole('button', { name: '开始同步 →' }).click();
  for (let number = 1; number <= 2; number++) {
    await page.getByRole('link', { name: '打开内部 PR ↗', exact: true }).waitFor({ timeout: 30000 });
    const active = (await receiver.status()).active;
    if (number === 2) assert.equal(active.source.kind, 'commit');
    assert.equal(active.prUrl, `https://codehub.example/core/pull/${number}`);
    assert.equal(await page.locator('[data-stage]').count(), 5);
    assert.equal(await page.locator('[data-stage-state="done"][open]').count(), 0);
    assert.equal(
      await page.locator('[data-stage][open]').count(),
      0,
      'all stages start collapsed during active sync',
    );
    if (number === 1)
      await page.screenshot({
        path: join(evidence, 'automatic-waiting-review.png'),
        fullPage: true,
      });
    await page.getByRole('button', { name: '展开全部阶段' }).click();
    assert.ok((await page.locator('[data-stage="2"]').innerText()).includes('创建 / 复用并回读内部 Issue'));
    assert.equal(
      await page
        .locator('[data-stage="3"] [data-step-key="issue-link"]')
        .getAttribute('data-operation-state'),
      'DONE',
    );
    const issueLink = page.locator('[data-stage="3"] [data-step-key="issue-link"]');
    assert.ok(active.issues.length, 'fixture must verify actual Issue associations');
    for (const issue of active.issues) {
      const label = `关联并回读内部 PR 与 Issue #${issue.number}`;
      const evidence = issueLink.locator('[data-attempt]').filter({ hasText: label });
      assert.ok(
        await evidence.count(),
        `the original Issue #${issue.number} association evidence must remain`,
      );
      assert.ok((await issueLink.innerText()).includes(label));
    }
    assert.equal(
      await git(receiver.git.directory, ['show', `${active.candidate}:README.md`]),
      '内部默认中文版',
    );
    if (number === 2) await platform.edit({ loseUpdate: true });
    await f.merge(active);

    if (number === 2) {
      await page.getByRole('button', { name: '恢复原同步 →' }).waitFor({ timeout: 30000 });
      assert.equal((await receiver.status()).active.status, 'CODE_ACCEPTED_PENDING_METADATA');
      assert.equal(await page.locator('[data-flow-stage="5"][data-flow-state="failed"]').count(), 1);
      await page.screenshot({
        path: join(evidence, 'continuous-recovery.png'),
        fullPage: true,
      });
      await platform.edit({ loseUpdate: false });
      await page.getByRole('button', { name: '恢复原同步 →' }).click();
    }
    await page.waitForFunction(() => document.querySelectorAll('[data-stage]').length === 5);
    for (
      let retry = 0;
      retry < 100 && (await receiver.status()).deliveries[number - 1].status !== 'COMPLETE';
      retry++
    )
      await new Promise((done) => setTimeout(done, 200));
    assert.equal((await receiver.status()).deliveries.at(-1).status, 'COMPLETE');
    await openHistory(page);
    await page.locator(`.records-page [data-record="${active.id}"]`).click();
    await page.getByText('历史记录 · 只读', { exact: true }).waitFor();
    await page.getByRole('button', { name: '展开全部阶段' }).click();
    await page.getByText('当时配置与来源', { exact: true }).click();
    assert.ok((await page.locator('.records-detail').innerText()).includes('README.en.md'));
    assert.equal(await page.locator('.records-detail [data-action]').count(), 0);
    await page.getByRole('button', { name: '返回当前同步', exact: true }).click();
  }
  const state = await receiver.status();
  assert.equal(state.accepted.upstream, f.u2);
  assert.equal(state.automation.status, 'COMPLETE');
  assert.ok(state.deliveries.every((d) => d.commitMappings.every((m) => m.source !== m.internal)));
  assert.equal((await platform.read()).creates, 1);
  assert.equal((await platform.read()).updates, 1, 'lost update receipt must not repeat close');
  assert.equal(JSON.parse(await readFile(counter, 'utf8')), 2);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS：过程模式目标 tag、逐笔 PR、README 保留、Issue 自动创建/关联/关单、失败 × 与原对象恢复、历史配置和移动端。',
  );
} finally {
  await closeBrowser();
  await server.shutdown();
}

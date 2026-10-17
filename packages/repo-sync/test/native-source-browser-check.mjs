import { launchOwnedBrowser } from './owned-browser.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { createConnection } from '../src/connections.mjs';
import { command } from '../src/process.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { continuousRepositories } from './continuous-fixtures.mjs';

const f = await continuousRepositories(),
  folder = await mkdtemp(join(tmpdir(), 'repo-sync-native-source-'));
const environment = { ...process.env },
  nativeFetch = globalThis.fetch;
Object.assign(process.env, {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: `url.${f.source.replaceAll('\\', '/')}.insteadOf`,
  GIT_CONFIG_VALUE_0: 'https://github.com/demo/core.git',
});
delete process.env.GH_TOKEN;
delete process.env.GITHUB_TOKEN;
for (const key of Object.keys(process.env)) if (key.toUpperCase() === 'PATH') delete process.env[key];
process.env.PATH =
  process.platform === 'win32'
    ? ['C:/Program Files/Git/cmd', dirname(process.execPath), `${process.env.SystemRoot}/System32`].join(';')
    : '/usr/bin:/bin';
const file = join(folder, 'config.json');
await writeFile(
  file,
  JSON.stringify({ ...f.config, sourceUrl: 'https://github.com/demo/core.git', configurationSource: 'workbench' }),
);
const connection = await createConnection(file),
  receiver = await connection.current();
await receiver.adopt(f.u0, f.i0);
const prs = f.plans.map((plan) => ({
  node_id: plan.source.id,
  number: plan.source.number,
  html_url: plan.source.url,
  title: plan.source.title,
  body: 'Refs #71',
  merged: true,
  merged_at: '2026-10-15T00:00:00Z',
  merge_commit_sha: plan.target,
  base: { ref: 'releases' },
}));
const sourceToken = 'SYNTHETIC_NATIVE_SOURCE_TOKEN';
let graphqlCalls = 0;
globalThis.fetch = async (input, options) => {
  const url = new URL(String(input));
  if (url.origin !== 'https://api.github.com') return nativeFetch(input, options);
  assert.equal(options.redirect, 'error');
  const path = url.pathname;
  if (path === '/graphql') {
    graphqlCalls++;
    assert.equal(options.headers.Authorization, `Bearer ${sourceToken}`);
    const { query } = JSON.parse(options.body),
      pageInfo = { hasNextPage: false, endCursor: null };
    if (query.includes('closingIssuesReferences'))
      return Response.json({
        data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [], pageInfo } } } },
      });
    return Response.json({
      data: {
        node: {
          timelineItems: {
            nodes: [{ id: 'closed-event', createdAt: '2026-10-15T00:00:00Z', closer: { id: prs[1].node_id } }],
            pageInfo,
          },
        },
      },
    });
  }
  if (path === '/repos/demo/core') return Response.json({ node_id: 'synthetic-repository', full_name: 'demo/core' });
  if (path.includes('/commits/')) return Response.json(prs.filter((pr) => path.includes(pr.merge_commit_sha)));
  if (path.includes('/pulls/')) return Response.json(prs.find((pr) => path.endsWith(`/${pr.number}`)));
  if (path === '/repos/demo/core/issues/71')
    return Response.json({
      node_id: 'issue-71',
      number: 71,
      html_url: 'https://github.com/demo/core/issues/71',
      title: 'Synthetic shared issue',
      body: 'Public fixture issue',
      state: 'closed',
    });
  throw Error('Unexpected native source request');
};
const server = createReceiverServer(null, { connection });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const { browser, close: closeBrowser } = await launchOwnedBrowser(chromium, {
  headless: true,
  executablePath: process.env.REPO_SYNC_CHROME,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
  errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const evidence = process.env.REPO_SYNC_EVIDENCE || join(folder, 'evidence');
await mkdir(evidence, { recursive: true });
try {
  if (process.platform === 'win32')
    await assert.rejects(() => command('gh', ['--version']), { code: 'COMMAND_NOT_FOUND' });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByLabel('目标类型').selectOption('tag');
  await page.getByLabel('目标 tag 名称 / 完整 commit SHA').fill('v2.0.0');
  await page.getByRole('button', { name: '读取到目标版本的 PR 清单 →' }).click();
  await page
    .locator('#operation')
    .getByText(/GITHUB_AUTH_REQUIRED/)
    .first()
    .waitFor({ timeout: 30000 });
  assert.equal((await receiver.status()).queue.length, 0);
  assert.equal((await receiver.status()).accepted.upstream, f.u0);
  assert.equal(graphqlCalls, 0);
  await page.getByRole('button', { name: '配置 GitHub 读取认证', exact: true }).click();
  await page.getByLabel('GitHub 读取 Token', { exact: true }).fill(sourceToken);
  await page.getByRole('button', { name: '保存 Token 到本次服务', exact: true }).click();
  await page.getByText(/Token 已保存到本次服务/).waitFor();
  assert.equal(await page.getByLabel('GitHub 读取 Token', { exact: true }).inputValue(), '');
  assert.equal(await page.evaluate((secret) => JSON.stringify(sessionStorage).includes(secret), sourceToken), false);
  assert.equal((await readFile(file, 'utf8')).includes(sourceToken), false);
  await page.getByRole('button', { name: '同步工作台', exact: true }).click();
  assert.equal(await page.getByLabel('目标 tag 名称 / 完整 commit SHA').inputValue(), 'v2.0.0');
  await page.getByRole('button', { name: '读取到目标版本的 PR 清单 →' }).click();
  await page.getByRole('button', { name: '同步上游 PR #1 →' }).waitFor({ timeout: 30000 });
  const state = await receiver.status();
  assert.equal(state.queue.length, 2);
  assert.equal(state.queue[0].issues[0].relation, 'related');
  assert.equal(state.queue[1].issues[0].relation, 'closes');
  assert.deepEqual(state.queue[1].issues[0].requiredTargets, [f.u1, f.u2]);
  assert.ok(graphqlCalls >= 4);
  assert.equal(
    JSON.stringify(await (await nativeFetch(`http://127.0.0.1:${server.address().port}/api/status`)).json()).includes(
      sourceToken,
    ),
    false,
  );
  await page.screenshot({ path: join(evidence, 'native-source-without-gh.png'), fullPage: false });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: real Git tag, no gh on Windows PATH, native REST/GraphQL, missing-token failure, memory-only project token, unchanged baseline and resumed two-PR/Issue closure provenance.',
  );
} finally {
  await closeBrowser();
  await server.shutdown();
  globalThis.fetch = nativeFetch;
  for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
  Object.assign(process.env, environment);
}

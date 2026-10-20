import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createConnection } from '../src/connections.mjs';
import { git } from '../src/process.mjs';
import { createReceiverServer } from '../src/server.mjs';
import { codehubPlatform } from './codehub-fixture.mjs';
import { continuousRepositories } from './continuous-fixtures.mjs';
import { launchOwnedBrowser } from './owned-browser.mjs';
import { activateBaseline } from './setup-journey-helpers.mjs';

// Real Git + production entry; GitHub metadata and CodeHub-compatible HTTP are synthetic fixtures.
const f = await continuousRepositories(),
  platform = await codehubPlatform(f);
const folder = await mkdtemp(join(tmpdir(), 'repo-sync-process-setup-')),
  file = join(folder, 'config.json');
const sourceToken = 'SYNTHETIC_INITIAL_GITHUB_TOKEN',
  nativeFetch = globalThis.fetch;
const env = {
  GH_TOKEN: '',
  GITHUB_TOKEN: '',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: `url.${f.source.replaceAll('\\', '/')}.insteadOf`,
  GIT_CONFIG_VALUE_0: 'https://github.com/demo/core.git',
  GIT_CONFIG_KEY_1: `url.${f.internal.replaceAll('\\', '/')}.insteadOf`,
  GIT_CONFIG_VALUE_1: 'git@codehub.example:innersource/team_G/core.git',
};
const original = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
Object.assign(process.env, env);
let sourceChecks = 0;
globalThis.fetch = async (input, options) => {
  const url = new URL(String(input));
  if (url.origin === 'https://api.github.com') {
    assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${sourceToken}`);
    sourceChecks++;
    if (url.pathname === '/repos/demo/core')
      return Response.json({ full_name: 'demo/core', node_id: 'fixture-repository' });
    if (url.pathname === '/graphql')
      return Response.json({ data: { viewer: { login: 'synthetic-reader' } } });
    throw Error(`Unexpected synthetic GitHub request: ${url.pathname}`);
  }
  if (url.origin === 'https://codehub.example' && url.pathname.startsWith('/api/v4/'))
    return nativeFetch(`${platform.api}${url.pathname.slice('/api/v4'.length)}${url.search}`, options);
  return nativeFetch(input, options);
};
const pr = {
  node_id: f.plans[0].source.id,
  number: 1,
  html_url: f.plans[0].source.url,
  title: f.plans[0].source.title,
  merged: true,
  merged_at: '2026-10-15T00:00:00Z',
  merge_commit_sha: f.u1,
  base: { ref: 'releases' },
};
const sourceProvider = {
  api: async (path) =>
    path === 'repos/demo/core'
      ? { node_id: 'fixture-repository' }
      : path.includes('/commits/')
        ? path.includes(f.u1)
          ? [pr]
          : []
        : path === 'repos/demo/core/pulls/1'
          ? pr
          : assert.fail(`Unexpected synthetic source route ${path}`),
  collectIssues: async (_, sourcePr) => [
    { ...f.plans[sourcePr ? 0 : 1].issues[0], relation: sourcePr ? 'related' : 'closes' },
  ],
};
const connection = await createConnection(file),
  server = createReceiverServer(null, { connection, sourceProvider, syncInterval: 100 });
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const { browser, close: closeBrowser } = await launchOwnedBrowser(chromium, {
  headless: true,
  executablePath: process.env.REPO_SYNC_CHROME,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } }),
  errors = [];
page.setDefaultTimeout(15000);
page.on('pageerror', (error) => errors.push(error.message));
const evidence = process.env.REPO_SYNC_EVIDENCE || join(folder, 'evidence');
await mkdir(evidence, { recursive: true });
async function noPersistedTokens(receiver) {
  const files =
    (await readFile(file, 'utf8')) +
    (receiver ? await readFile(receiver.store.path, 'utf8').catch(() => '') : '');
  const storage = await page.evaluate(() =>
    JSON.stringify({ session: { ...sessionStorage }, local: { ...localStorage } }),
  );
  for (const secret of [sourceToken, platform.token]) {
    assert.equal(files.includes(secret), false);
    assert.equal(storage.includes(secret), false);
  }
}
async function waitState(receiver, predicate) {
  for (let retry = 0; retry < 200; retry++) {
    const state = await receiver.status();
    if (predicate(state)) return state;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.fail('process journey did not reach the expected durable state');
}
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/?view=configuration`);
  assert.equal(await connection.current(), null);
  await page.locator('[data-mode-card="continuous"]').click();
  const form = page.locator('[data-form="configure-repositories"]');
  await form.getByLabel('外部 GitHub 仓库地址').fill('https://github.com/demo/core.git');
  await form.getByLabel('外部交付分支').fill('releases');
  await form
    .getByLabel('内部 Git 仓库地址', { exact: true })
    .fill('git@codehub.example:innersource/team_G/core.git');
  await form.getByLabel('内部仓库网页地址（登记对象前必填）').fill(platform.web);
  await form.locator('[data-next-auth]').click();
  await form.getByLabel('GitHub 读取 Token（开发过程模式需要）').fill(sourceToken);

  await form.getByLabel('PR 创建方式', { exact: true }).selectOption('gitlab');
  await form.getByLabel('Issue 创建与关单方式').selectOption('gitlab');
  await form.getByLabel('内部 Issue 网页链接').fill(`${platform.web}/issues`);
  await form.getByLabel('内部平台 Token', { exact: true }).fill(platform.token);
  await form.getByText('首次接收条件：提交消息关单规则', { exact: true }).click();
  await form.locator('[name="commitClosureVerified"]').check();
  await form.locator('.identity-advanced > summary').click();
  await form.getByLabel('提交处理方式').selectOption('rewrite');
  if (!(await form.getByLabel('内部 Git 姓名').isVisible()))
    await form.getByText('姓名与邮箱（重写模式必填；保留模式用于接收节点）', { exact: true }).click();
  await form.getByLabel('内部 Git 姓名').fill('Internal Receiver');
  await form.getByLabel('内部 Git 邮箱').fill('receiver@example.invalid');
  await page.getByRole('button', { name: '保存并检查连接 →', exact: true }).click();
  await page.getByRole('heading', { name: '2 · 核验已有同步起点', exact: true }).waitFor({ timeout: 30000 });
  assert.ok(sourceChecks >= 2, 'initial configuration must verify the provided GitHub credential');
  assert.equal(
    platform.state.creates.issues + platform.state.creates.prs,
    0,
    'read checks cannot create objects',
  );
  assert.equal(await page.getByLabel('内部当前接收位置').inputValue(), f.i0);
  let receiver = await connection.current();
  await noPersistedTokens(receiver);
  await page.reload();
  await page.getByLabel('上次已经接收的外部版本').fill('v1.0.0');
  await page.getByRole('button', { name: '核验起点并查看文件 →', exact: true }).click();
  await page.locator('#baseline-differences [data-rule-choice="README.md"]').waitFor({ timeout: 30000 });
  for (const path of ['README.md', 'README.cn.md', 'README.en.md'])
    await page.locator(`[data-rule-choice="${path}"]`).check();
  await page.getByRole('button', { name: '应用选择并重新核验', exact: true }).click();
  await page.getByRole('button', { name: '继续确认启用 →', exact: true }).waitFor({ timeout: 30000 });
  receiver = await connection.current();
  assert.equal(await receiver.status(), null);
  await activateBaseline(page, receiver);
  await page.getByLabel('目标类型').selectOption('tag');
  await page.getByLabel('目标 tag 名称 / 完整 commit SHA').fill('v2.0.0');
  await page.getByRole('button', { name: '开始同步 →', exact: true }).click();
  for (let number = 1; number <= 2; number++) {
    await waitState(
      receiver,
      (state) =>
        state.active?.prUrl === `${platform.web}/merge_requests/${number}` &&
        state.automation.status === 'WAITING_REVIEW',
    );
    await page
      .locator(`.next-action a[href="${platform.web}/merge_requests/${number}"]`)
      .waitFor({ timeout: 30000 });
    const active = (await receiver.status()).active;
    assert.equal(active.source.kind, number === 1 ? 'pr' : 'commit');
    assert.equal(await page.locator('.primary:visible').count(), 1);
    assert.equal(
      await page.getByRole('link', { name: '打开内部 PR ↗', exact: true }).getAttribute('href'),
      active.prUrl,
    );
    await page.reload();
    await page.getByRole('link', { name: '打开内部 PR ↗', exact: true }).waitFor({ timeout: 30000 });
    assert.equal((await receiver.status()).active.id, active.id);
    assert.equal(platform.state.creates.prs, number, 'refresh cannot duplicate the current PR');
    await noPersistedTokens(receiver);
    assert.ok(active.commitMappings.every((mapping) => mapping.source !== mapping.internal));
    const identity = await git(receiver.git.directory, [
      'show',
      '-s',
      '--format=%an <%ae>|%cn <%ce>',
      active.commitMappings[0].internal,
    ]);
    assert.equal(
      identity,
      'Internal Receiver <receiver@example.invalid>|Internal Receiver <receiver@example.invalid>',
    );
    assert.equal(
      await git(receiver.git.directory, ['show', `${active.candidate}:README.md`]),
      '内部默认中文版',
    );
    assert.equal(
      await git(receiver.git.directory, ['show', `${active.candidate}:README.en.md`]),
      'Internal English documentation',
    );
    assert.equal(
      (await git(receiver.git.directory, ['ls-tree', '--name-only', active.candidate])).includes(
        'README.cn.md',
      ),
      false,
    );
    if (number === 2)
      assert.equal(
        platform.state.issues[0].state,
        'opened',
        'ordinary association and pending deliveries cannot close the Issue',
      );
    await f.merge(active);
    await waitState(receiver, (state) => state.deliveries[number - 1]?.status === 'COMPLETE');
  }
  const state = await waitState(receiver, (saved) => saved.automation.status === 'COMPLETE');
  assert.equal(state.accepted.upstream, f.u2);
  assert.equal(state.deliveries.length, 2);
  assert.equal(platform.state.creates.issues, 1);
  assert.equal(platform.state.creates.prs, 2);
  assert.equal(platform.state.issues[0].state, 'closed');
  assert.equal(await git(f.internal, ['show', 'main:core.txt']), 'second');
  await noPersistedTokens(receiver);
  await page.getByRole('heading', { name: '当前已接收版本' }).waitFor({ timeout: 30000 });
  await page.screenshot({ path: join(evidence, 'process-setup-complete.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: empty process setup, initial synthetic credential checks, historical tag, three README preservation rules, explicit activation, one intent through PR/direct commit, mapped internal identity, refresh recovery, real Git merges and automatic Issue closure. CodeHub/GitHub APIs are test doubles, not internal deployment acceptance.',
  );
} catch (error) {
  console.error(error);
  console.error(
    'Process journey page errors:',
    errors,
    '\nVisible page:',
    await page.locator('body').innerText(),
  );
  await page
    .screenshot({ path: join(evidence, 'process-setup-failure.png'), fullPage: true, timeout: 5000 })
    .catch(() => {});
  throw error;
} finally {
  await closeBrowser();
  await server.shutdown();
  await platform.close();
  globalThis.fetch = nativeFetch;
  for (const [key, value] of Object.entries(original))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}

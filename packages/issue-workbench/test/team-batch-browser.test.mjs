import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { setup } from './helpers/team-fixture.ts';
import { newInvestigation } from '../src/model/issue-coordination.ts';
import { issueVersion } from '../src/team/schema.ts';
import { sourceId } from '../src/team/coordination.ts';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
execFileSync('pnpm', ['build'], { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'pipe' });

for (const delivery of ['assignment', 'invitation']) test(`packed bulk board (${delivery}): complete Open snapshot, edits, skips, confirmation, system dispatch and durable restart`, { timeout: 90000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'issue-batch-browser-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const [pack] = JSON.parse(execFileSync(process.execPath, ['scripts/pack-publish-artifact.mjs', 'packages/issue-workbench', directory], { cwd: repo, encoding: 'utf8' }));
  execFileSync('tar', ['-xzf', join(directory, pack.filename), '-C', directory]);
  const { createIssueTeamModule, GhTeamProvider } = await import(pathToFileURL(join(directory, 'package/dist/team-plugin.js')).href);
  const { coordinationPreview, fixtureBindings } = await import(pathToFileURL(join(directory, 'package/dist/coordination-host.mjs')).href);
  const s = setup(); s.config.automaticAssignment = false; s.config.analysisThreadId = 'analysis'; s.config.routingRules = '[]';
  s.config.dispatchMode = delivery; if (delivery === 'invitation') s.login('bob');
  const eligibility = new GhTeamProvider(async args => {
    if (args[3] === 'repos/fixture/repo/assignees?per_page=100') return JSON.stringify([[{ login: 'Alice' }], [{ login: 'Bob' }]]);
    throw new Error('GitHub request failed (HTTP 404)');
  });
  s.provider.assignable = (...args) => eligibility.assignable(...args);
  const original = structuredClone(s.issues[0]);
  s.issues.splice(0, 1, ...Array.from({ length: 7 }, (_, index) => ({ ...structuredClone(original), id: `issue-${index + 1}`, number: index + 1,
    title: ['启动时会话初始化失败', 'Windows 工具路径解析失败', 'macOS 配置同步问题', '历史消息显示异常', '已经认领的问题', '尚未分析的新问题', '跨平台环境差异'][index],
    url: `https://github.com/fixture/repo/issues/${index + 1}`, body: index === 1 ? 'Windows tool path failed' : index === 6 ? 'Windows and macOS both fail' : original.body,
    assignees: index === 4 ? ['bob'] : [] })));
  const host = { ...s.context, dataPath: directory, messaging: { ...s.context.messaging, send: ({ threadId, ...draft }) => s.context.messaging.send(threadId, draft) } };
  const start = () => createIssueTeamModule(s.provider).create({ pluginId: 'dev.clowder.issue-workbench', runtime: { entrypoint: 'dist/team-plugin.js' } }).start(host);
  let active = await start(), operations = 0; t.after(() => active.stop());
  const call = async (method, payload, confirmed) => {
    if (['confirmAssignmentBatch', 'retryAssignmentBatch'].includes(method) && !confirmed) throw Object.assign(new Error('Confirm first'), { status: 400 });
    return active.actions['issue.workbench.' + method]({ input: { payload: JSON.stringify(payload) } }, undefined, {
      kind: 'owner-operation', pluginInstanceId: 'isolated-test', userId: 'owner', operationKey: 'teamWorkbench', actionId: method,
      requestId: 'batch-browser-' + ++operations, signal: new AbortController().signal, assertCurrent: async () => {},
    });
  };
  for (const issue of s.issues.filter(i => i.number !== 6)) {
    await call('coordination', { action: 'saveWork', expectedRevision: 0, value: { ...newInvestigation({ sourceId: sourceId(issue.repo), issueId: issue.id, number: issue.number }, issue.title,
      issueVersion(issue), { enabled: true, name: '', branch: '', base: '' }), module: 'Agent 运行' } });
  }
  const binding = fixtureBindings()[0], catalog = await binding.catalog();
  binding.profile = { ...binding.profile, provider: 'github', instance: 'https://github.com', repository: 'fixture/repo', synthetic: false };
  const fact = issue => ({ ...catalog.issues[0], id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: 'OPEN', assignees: issue.assignees });
  binding.catalog = async () => ({ ...catalog, issues: s.issues.map(fact) }); binding.detail = async ref => ({ fact: { ...fact(s.issues.find(i => i.id === ref.issueId) ?? s.issues[0]), comments: [] } });
  const server = coordinationPreview({ dataRoot: join(directory, 'data'), dist: join(directory, 'package/dist'), bindings: [binding], teamAction: call });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.getByRole('button', { name: '批量派工', exact: true }).click();
  const board = page.getByRole('dialog', { name: '批量派工', exact: true });
  await board.getByRole('button', { name: '读取当前 Open 问题看板' }).click();
  await board.getByText('全部 7', { exact: true }).waitFor();
  assert.deepEqual(s.writes, []); assert.equal(await board.locator('article').count(), 7);
  assert.ok(await board.getByRole('button', { name: '核对并派工', exact: true }).isDisabled());
  await board.getByLabel('调整 fixture/repo#3 指派成员', { exact: true }).selectOption('alice');
  for (const number of [2, 4, 6, 7]) {
    const target = board.getByLabel(`本次参与 fixture/repo#${number}`, { exact: true });
    let release;
    if (number === 2) {
      const pending = new Promise(resolve => { release = resolve; });
      await page.route('**/editAssignmentBatch', async route => { await pending; await route.continue(); });
    }
    const saved = page.waitForResponse(r => r.url().endsWith('/editAssignmentBatch'));
    await target.click();
    if (number === 2) {
      try {
        assert.equal(await target.isChecked(), false, 'clicked selection responds while the request is pending');
        const other = board.getByLabel('本次参与 fixture/repo#1', { exact: true });
        assert.equal(await other.isChecked(), true, 'unrelated selection stays checked');
        await board.getByText('正在保存 #2 的调整…', { exact: true }).waitFor();
        assert.notEqual(await other.evaluate(el => getComputedStyle(el).backgroundColor),
          await target.evaluate(el => getComputedStyle(el).backgroundColor), 'checked and unchecked boxes remain visibly distinct during save');
        assert.ok(await board.getByRole('button', { name: '核对并派工', exact: true }).isDisabled());
        await mkdir('artifacts/batch-checkbox-2026-10-27', { recursive: true });
        await page.screenshot({ path: 'artifacts/batch-checkbox-2026-10-27/saving.png', fullPage: true });
      } finally { release(); }
    }
    assert.ok((await saved).ok());
    await page.waitForFunction(label => {
      const input = document.querySelector(`[aria-label="${label}"]`); return !input.checked && !input.disabled;
    }, `本次参与 fixture/repo#${number}`);
    if (number === 2) await page.unroute('**/editAssignmentBatch');
    assert.equal(await board.getByLabel('本次参与 fixture/repo#1', { exact: true }).isChecked(), true);
  }
  await mkdir('artifacts/batch-assignment-2026-10-26', { recursive: true });
  await board.evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: 'artifacts/batch-assignment-2026-10-26/board-desktop.png', fullPage: true });
  const review = board.getByRole('button', { name: '核对并派工', exact: true });
  const assertRevealed = async target => {
    const visible = await target.evaluate(el => {
      const rect = el.getBoundingClientRect(), clip = el.closest('dialog').getBoundingClientRect();
      return { inside: rect.top >= clip.top && rect.bottom <= clip.bottom,
        focused: document.activeElement === el };
    });
    assert.equal(visible.inside, true, 'new feedback is inside the scrollable dialog without manual scrolling');
    assert.equal(visible.focused, true, 'keyboard focus follows new feedback');
  };
  await mkdir('artifacts/batch-confirm-2026-10-27', { recursive: true });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    // A person can reach the review button at the bottom edge of a long list.
    // Do not let Playwright scroll the newly inserted confirmation into view.
    await review.evaluate(el => el.scrollIntoView({ block: 'end' }));
    await review.click();
    const confirmation = board.getByRole('alertdialog', { name: '确认批量派工' });
    await confirmation.getByText(delivery === 'invitation' ? '即将发送 2 条任务邀请，不设置 GitHub 负责人，并以 system 为提交人标识发布说明。'
      : '即将设置 2 个 Issue 的 GitHub 负责人，并以 system 为提交人标识发布说明。', { exact: true }).waitFor();
    await assertRevealed(confirmation);
    assert.deepEqual(s.writes, []);
    await page.screenshot({ path: `artifacts/batch-confirm-2026-10-27/confirmation-${viewport.width}.png` });
    if (viewport.width > 700) {
      await confirmation.getByRole('button', { name: '返回调整' }).click();
      assert.equal(await review.evaluate(el => document.activeElement === el), true);
    }
  }
  // A rejected preflight must be visible too, even though its alert is above the long list.
  await page.route('**/confirmAssignmentBatch', route => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: '成员不可指派，请调整后重试' }) }));
  await board.getByRole('button', { name: '确认批量派工', exact: true }).click();
  const alert = board.getByRole('alert').filter({ hasText: '成员不可指派' });
  await alert.waitFor(); await assertRevealed(alert); assert.deepEqual(s.writes, []);
  await page.screenshot({ path: 'artifacts/batch-confirm-2026-10-27/preflight-error.png' });
  await page.unroute('**/confirmAssignmentBatch');
  await review.click();
  await page.screenshot({ path: 'artifacts/batch-assignment-2026-10-26/board-mobile.png', fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await board.getByRole('button', { name: '确认批量派工', exact: true }).click();
  await board.getByText('执行中', { exact: true }).waitFor();
  await active.actions['issue.team.poll']({});
  await board.getByRole('button', { name: '刷新进度', exact: true }).click();
  await board.getByText('本批派工完成', { exact: true }).waitFor();
  assert.equal(await board.getByRole('progressbar', { name: '批量派工进度' }).getAttribute('value'), '2');
  assert.deepEqual(s.writes, delivery === 'invitation' ? [] : ['alice', 'alice']); assert.equal(s.dispatches.length, 2);
  if (delivery === 'invitation') {
    assert.ok(s.dispatches.every(d => d.delivery === 'invitation'));
    assert.equal(await board.getByText('已邀请 / 待接手', { exact: true }).count(), 2);
    assert.deepEqual(s.issues[0].assignees, []);
  }
  assert.ok(s.dispatches.every(d => d.initiator === 'system' && !d.acceptanceSuggestedFor));
  assert.deepEqual(s.issues[4].assignees, ['bob']); assert.deepEqual(s.issues[3].assignees, []);
  await active.stop(); active = await start(); await page.reload();
  await page.getByRole('button', { name: '批量派工', exact: true }).click();
  await board.getByText('本批派工完成', { exact: true }).waitFor();
  await active.actions['issue.team.poll']({}); assert.equal(s.writes.length, delivery === 'invitation' ? 0 : 2); assert.equal(s.dispatches.length, 2);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'artifacts/batch-assignment-2026-10-26/completed.png', fullPage: true });
  await mkdir('artifacts/official-dispatch-2026-10-27', { recursive: true });
  await page.screenshot({ path: `artifacts/official-dispatch-2026-10-27/completed-${delivery}.png`, fullPage: true });
  assert.deepEqual(errors, []);
});

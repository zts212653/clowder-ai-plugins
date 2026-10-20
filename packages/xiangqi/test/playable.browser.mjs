import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { startPlayableXiangqi } from '../src/plugin-entrypoint.mjs';

test('owner-launched board plays, refreshes and isolates two conversation/cat bindings', { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'xiangqi-playable-browser-'));
  const sends = [];
  const host = { dataPath: root, pluginInstanceId: 'installed-a',
    threads: { async get(id) { return { id }; }, async getCats() {
      return { participants: [{ catId: 'cat-a', displayName: '橙猫' }, { catId: 'cat-b', displayName: '青猫' }], routableNow: [] };
    } },
    messaging: { async get(id) { return { userId: 'owner-a', catId: null, threadId: id === 'human-b' ? 'conversation-b' : 'conversation-a' }; },
      async send(input) { sends.push(input); return { messageId: `receipt-${sends.length}` }; } },
  };
  const runtime = await startPlayableXiangqi(host);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await runtime.stop(); rmSync(root, { recursive: true, force: true }); });
  const caller = { userId: 'owner-a', threadId: 'conversation-a', catId: 'cat-a', invocationId: 'turn-a',
    ownerAuthProvenance: 'strict', source: { kind: 'primary', sourceMessageId: 'human-a' }, async assertCurrent() {} };
  const secondCaller = { ...caller, threadId: 'conversation-b', catId: 'cat-b', source: { kind: 'primary', sourceMessageId: 'human-b' } };
  const first = await runtime.actions['xiangqi.open']({}, caller), second = await runtime.actions['xiangqi.open']({}, secondCaller);
  const launch = async game => (await runtime.actions['xiangqi.launch']({ request: { method: 'GET', path: `board/${game.gameId}`, principal: { id: 'owner-a' } } }, undefined,
    { kind: 'owner-http-request', operation: 'read', userId: 'owner-a', pluginInstanceId: 'installed-a', signal: new AbortController().signal, async assertCurrent() {} })).body;
  const page = await browser.newPage({ viewport: { width: 1120, height: 900 } });
  await page.context().addCookies([
    { name: 'cat_cafe_session', value: 'fixture-ip-owner-session', url: 'http://127.0.0.1:3216' },
    { name: 'cat_cafe_session', value: 'fixture-name-owner-session', url: 'http://localhost:3216' },
  ]);
  const outgoing = [];
  page.on('request', request => outgoing.push(request.allHeaders()));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(await launch(first));
  await page.getByRole('link', { name: '打开本地棋盘', exact: true }).click();
  await page.getByText('轮到你', { exact: true }).waitFor();
  assert.equal((await Promise.all(outgoing)).some(headers => headers.cookie?.includes('fixture-')), false,
    'a game process must not receive the Host browser session cookie across loopback ports');
  assert.equal(new URL(page.url()).hash, '', 'launch secret is removed from browser history');
  assert.equal(await page.locator('.piece').count(), 32);
  await page.locator('[data-index="64"]').click();
  await page.locator('[data-index="67"]').click();
  await page.getByRole('button', { name: '确认落子并发送', exact: true }).click();
  await page.getByText('等橙猫应招', { exact: true }).waitFor();
  const report = await runtime.actions['xiangqi.read']({ gameId: first.gameId, revision: 1, timeMs: 50, maxDepth: 2 }, caller);
  await runtime.actions['xiangqi.play']({ gameId: first.gameId, revision: 1, move: report.candidates[0].ucci }, caller);
  await page.getByText('轮到你', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('轮到你', { exact: true }).waitFor();
  assert.equal(await page.locator('#history li').count(), 1);
  const narrow = await browser.newPage({ viewport: { width: 480, height: 900 } });
  narrow.on('pageerror', error => errors.push(error.message));
  await narrow.setContent(await launch(second));
  await narrow.getByRole('link', { name: '打开本地棋盘', exact: true }).click();
  await narrow.getByText('轮到你', { exact: true }).waitFor();
  assert.equal(await narrow.locator('#heading-companion').textContent(), '青猫');
  assert.equal(await narrow.locator('#history li').count(), 0);
  assert.equal(await narrow.evaluate(() => document.body.scrollWidth), 480);
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].wake, { catId: 'cat-a' });
  assert.deepEqual(errors, []);
  if (process.env.XIANGQI_BROWSER_EVIDENCE_DIR) {
    await page.screenshot({ path: join(process.env.XIANGQI_BROWSER_EVIDENCE_DIR, 'desktop.png'), fullPage: true });
    await narrow.screenshot({ path: join(process.env.XIANGQI_BROWSER_EVIDENCE_DIR, 'narrow.png'), fullPage: true });
  }
});

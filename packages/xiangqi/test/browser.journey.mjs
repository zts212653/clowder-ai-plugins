import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { createHostedBoard } from '../src/board-server.mjs';
import { createHostedGame } from '../src/hosted-game.mjs';
import { INITIAL_FEN } from '../src/rules.mjs';
import { createGame, playGame, readGame, undoGame } from '../src/store.mjs';

for (const width of [1120, 480])
  test(`board confirmation, selected reply and recovery at ${width}px`, { timeout: 30000 }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'xiangqi-browser-'));
    createGame(root, 'browser-game');
    const session = Object.freeze({
      dataRoot: root,
      gameId: 'browser-game',
      humanName: 'Player Maple',
      companionName: 'Partner Cedar',
    });
    let notified = 0;
    const host = {
      openSession: () => session,
      async authorizeHumanAction() {},
      async authorizeCandidateRead() {},
      async authorizeCompanionMove() {},
      deliveryStatus: () => ({ status: notified ? 'accepted' : 'idle' }),
      async notifyConfirmedMove() { notified++; },
      async retryPending() {},
    };
    const app = createHostedBoard({
      host,
      prepare: () => ({ done: Promise.resolve({ ok: true }), cancel() {} }),
    });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    t.after(async () => {
      await browser.close();
      await new Promise((resolve) => app.close(resolve));
      rmSync(root, { recursive: true, force: true });
    });
    await page.goto(`http://127.0.0.1:${app.address().port}`);
    await page.getByText('轮到Player Maple', { exact: true }).waitFor();
    assert.equal(await page.locator('.piece').count(), 32);
    assert.equal(await page.locator('#heading-companion').textContent(), 'Partner Cedar');
    await page.locator('[data-index="64"]').click();
    await page.locator('[data-index="67"]').click();
    assert.equal(readGame(root, 'browser-game').revision, 0);
    assert.equal(notified, 0);
    await page.getByText('预选：炮八平五 · 尚未发送', { exact: true }).waitFor();
    await page.reload();
    await page.getByText('预选：炮八平五 · 尚未发送', { exact: true }).waitFor();
    await page.getByRole('button', { name: '取消预选', exact: true }).click();
    assert.equal(await page.locator('#confirm-move').isDisabled(), true);
    await page.locator('[data-index="64"]').click();
    await page.locator('[data-index="67"]').click();
    await page.getByRole('button', { name: '确认落子并发送', exact: true }).click();
    await page.getByText('等Partner Cedar应招', { exact: true }).waitFor();
    assert.equal(readGame(root, 'browser-game').moves[0].notation, '炮八平五');
    assert.equal(notified, 1);
    const companion = createHostedGame(host);
    const report = await companion.candidates(1, { timeMs: 100, maxDepth: 2 });
    await companion.commitCompanionMove(report.candidates[0].ucci, 1);
    await page.getByText('轮到Player Maple', { exact: true }).waitFor();
    assert.equal(await page.locator('#history li').count(), 1);
    await page.reload();
    assert.equal(readGame(root, 'browser-game').revision, 2);
    await page.getByRole('button', { name: '左右翻转' }).click();
    assert.equal(await page.locator('#red-files span').first().textContent(), '九');
    await page.reload();
    assert.equal(await page.locator('#red-files span').first().textContent(), '九');
    await page.getByRole('button', { name: '悔一回合' }).click();
    await page.waitForFunction(() => document.querySelector('#round')?.textContent === '尚未落子');
    assert.equal(readGame(root, 'browser-game').revision, 3);
    await page.locator('[data-index="64"]').click();
    await page.locator('[data-index="67"]').click();
    await page.getByRole('button', { name: '确认落子并发送', exact: true }).click();
    await page.getByRole('button', { name: '重新开局', exact: true }).click();
    assert.equal(readGame(root, 'browser-game').revision, 4);
    await page.getByRole('button', { name: '继续这盘', exact: true }).click();
    await page.getByRole('button', { name: '重新开局', exact: true }).click();
    await page.getByRole('button', { name: '确认重开', exact: true }).click();
    await page.getByText('轮到Player Maple', { exact: true }).waitFor();
    assert.equal(readGame(root, 'browser-game').revision, 5);
    assert.equal(readGame(root, 'browser-game').moves.length, 0);
    assert.equal(readGame(root, 'browser-game').events.length, 5);
    assert.equal(notified, 2);
    await page.locator('[data-index="64"]').click();
    await page.locator('[data-index="67"]').click();
    playGame(root, 'browser-game', '马二进三', { actor: 'human', expectedRevision: 5 });
    await page.getByText('等Partner Cedar应招', { exact: true }).waitFor();
    assert.equal(await page.locator('#confirm-move').isDisabled(), true);
    undoGame(root, 'browser-game', 1, 6);
    await page.getByText('轮到Player Maple', { exact: true }).waitFor();
    assert.equal(await page.locator('#confirm-move').isDisabled(), true);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  });

test('Host-selected human black side puts each name on the matching pieces', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'xiangqi-black-side-'));
  createGame(root, 'black-side', {
    fen: INITIAL_FEN.replace(' w - - ', ' b - - '),
    humanSide: 'black',
  });
  const session = Object.freeze({ dataRoot: root, gameId: 'black-side', humanName: 'Player Birch', companionName: 'Partner Elm' });
  const host = {
    openSession: () => session,
    async authorizeHumanAction() {},
    deliveryStatus: () => ({ status: 'idle' }),
    async notifyConfirmedMove() {},
    async retryPending() {},
  };
  const app = createHostedBoard({ host, prepare: () => ({ done: Promise.resolve({ ok: true }), cancel() {} }) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => app.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  await page.goto(`http://127.0.0.1:${app.address().port}`);
  await page.getByText('轮到Player Birch', { exact: true }).waitFor();
  assert.equal(await page.locator('#north-name').textContent(), 'Player Birch');
  assert.equal(await page.locator('#south-name').textContent(), 'Partner Elm');
  assert.equal(await page.locator('#red-label').textContent(), 'Partner Elm · 红');
  assert.equal(await page.locator('#black-label').textContent(), 'Player Birch · 黑');
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startPlayableXiangqi } from '../src/plugin-entrypoint.mjs';
import { readGame } from '../src/store.mjs';

function fixture(t, { loseReceipt = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'xiangqi-module-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const receipts = new Map(), sends = [];
  const host = {
    pluginInstanceId: 'installed-a',
    dataPath: root,
    threads: {
      async get(id) { return { id }; },
      async getCats() { return { participants: [{ catId: 'cat-a', displayName: '棋搭子甲' },
        { catId: 'cat-b', displayName: '棋搭子乙' }], routableNow: [] }; },
    },
    messaging: {
      async get() { return { catId: null, userId: 'owner-a', threadId: 'conversation-a' }; },
      async send(input) {
        sends.push(input);
        if (!receipts.has(input.idempotencyKey)) receipts.set(input.idempotencyKey, { messageId: `message-${receipts.size}` });
        if (loseReceipt) { loseReceipt = false; throw new Error('receipt connection lost after durable accept'); }
        return receipts.get(input.idempotencyKey);
      },
    },
  };
  const caller = { userId: 'owner-a', threadId: 'conversation-a', catId: 'cat-a', invocationId: 'turn-a',
    ownerAuthProvenance: 'strict', source: { kind: 'primary', sourceMessageId: 'human-a' }, async assertCurrent() {} };
  return { root, host, caller, sends, receipts };
}
async function browser(opened, runtime, userId = 'owner-a') {
  await assert.rejects(runtime.actions['xiangqi.launch']({ request: { method: 'GET', path: `board/${opened.gameId}`, principal: { id: userId } } }), /已认证用户/);
  const redirect = await runtime.actions['xiangqi.launch']({ request: { method: 'GET', path: `board/${opened.gameId}`, principal: { id: userId } } }, undefined,
    { kind: 'owner-http-request', operation: 'read', userId, pluginInstanceId: 'installed-a', signal: new AbortController().signal, async assertCurrent() {} });
  opened = { ...opened, url: redirect.headers.location };
  const url = new URL(opened.url), origin = url.origin;
  const secret = new URLSearchParams(url.hash.slice(1)).get('session');
  const exchange = await fetch(`${origin}/api/session`, { method: 'POST', headers: { origin, authorization: `Bearer ${secret}` } });
  assert.equal(exchange.status, 200);
  assert.equal(exchange.headers.get('set-cookie'), null, 'a sibling loopback port must not receive a game cookie');
  const authorization = `Bearer ${(await exchange.json()).session}`;
  const state = async () => {
    const response = await fetch(`${origin}/api/state`, { headers: { authorization } });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { origin, authorization, secret, state,
    async move() {
      const current = await state();
      const response = await fetch(`${origin}/api/move`, { method: 'POST',
        headers: { origin, authorization, 'content-type': 'application/json', 'x-chess-token': current.token },
        body: JSON.stringify({ move: current.legalMoves[0].ucci, revision: current.revision, confirmed: true }) });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    } };
}
async function eventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('notification did not settle');
}

test('real module, isolated child and authenticated HTTP play one human/cat round', async t => {
  const f = fixture(t), runtime = await startPlayableXiangqi(f.host);
  t.after(() => runtime.stop());
  await assert.rejects(runtime.actions['xiangqi.open']({}, undefined), /宿主认证/);
  await assert.rejects(runtime.actions['xiangqi.open']({ catId: 'cat-b' }, f.caller), /不支持/);
  const opened = await runtime.actions['xiangqi.open']({}, f.caller);
  assert.equal(opened.url, undefined, 'the cat must never receive the owner board bearer');
  assert.match(opened.launchPath, /^\/api\/plugins\/dev\.clowder\.xiangqi\/board\/game_/);
  const page = await browser(opened, runtime);
  await assert.rejects(browser(opened, runtime, 'other-owner'), /不属于/);
  assert.equal((await fetch(page.origin+'/api/state')).status, 403);
  const replay = await fetch(`${page.origin}/api/session`, { method: 'POST', headers: { origin: page.origin, authorization: `Bearer ${page.secret}` } });
  assert.equal(replay.status, 403, 'launch bearers are one use');
  const crossOrigin = await fetch(`${page.origin}/api/state`, { headers: { origin: 'https://foreign.invalid', authorization: page.authorization } });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await page.move()).revision, 1);
  await eventually(() => f.sends.length === 1);
  assert.deepEqual(f.sends[0].wake, { catId: 'cat-a' });
  assert.equal(f.sends[0].threadId, 'conversation-a');
  await assert.rejects(runtime.actions['xiangqi.read']({ gameId: opened.gameId, revision: 1 }, { ...f.caller, catId: 'cat-b' }), /不匹配/);
  await assert.rejects(runtime.actions['xiangqi.read']({ gameId: opened.gameId, revision: 1 }, { ...f.caller, threadId: 'conversation-b' }), /不匹配/);
  const report = await runtime.actions['xiangqi.read']({ gameId: opened.gameId, revision: 1, timeMs: 50, maxDepth: 2 }, f.caller);
  const move = report.candidates.find(candidate => !candidate.losesInOne).ucci;
  const committed = await runtime.actions['xiangqi.play']({ gameId: opened.gameId, revision: 1, move }, f.caller);
  assert.equal(committed.revision, 2);
  assert.equal((await page.state()).revision, 2, 'the cat personally submitted to the visible board');
  assert.equal((await runtime.actions['xiangqi.play']({ gameId: opened.gameId, revision: 1, move }, f.caller)).duplicate, true);
  await assert.rejects(runtime.actions['xiangqi.play']({ gameId: opened.gameId, revision: 0, move }, f.caller), /版本冲突/);
  await runtime.stop();
  assert.equal(readGame(join(f.root, 'games'), opened.gameId).revision, 2);
  await assert.rejects(fetch(`${page.origin}/api/state`));
  await assert.rejects(runtime.actions['xiangqi.read']({ gameId: opened.gameId, revision: 2 }, f.caller), /停止/);
});

test('lost Host receipt reconciles after a real child restart without a second move or wake', async t => {
  const f = fixture(t, { loseReceipt: true });
  const first = await startPlayableXiangqi(f.host);
  t.after(() => first.stop());
  const opened = await first.actions['xiangqi.open']({}, f.caller), page = await browser(opened, first);
  await page.move();
  await eventually(async () => (await page.state()).delivery.status === 'error');
  await first.stop({ reason: 'host-shutdown' });
  const second = await startPlayableXiangqi(f.host);
  t.after(() => second.stop());
  assert.equal(f.receipts.size, 1);
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[0].idempotencyKey, f.sends[1].idempotencyKey);
  const restored = await second.actions['xiangqi.open']({ gameId: opened.gameId }, f.caller);
  assert.equal(restored.revision, 1);
  const reopened = await browser(restored, second);
  assert.equal((await reopened.state()).history.length, 1);
});

test('untrusted opening source and revoked caller cannot acquire a board session', async t => {
  const f = fixture(t), runtime = await startPlayableXiangqi(f.host);
  t.after(() => runtime.stop());
  f.host.messaging.get = async () => ({ catId: null, userId: 'owner-a', threadId: 'conversation-a', source: { connector: 'another-plugin' } });
  await assert.rejects(runtime.actions['xiangqi.open']({}, f.caller), /人类授权/);
  await assert.rejects(runtime.actions['xiangqi.open']({}, { ...f.caller, async assertCurrent() { throw new Error('revoked'); } }), /revoked/);
});

test('explicit disable retains the game, revokes old work and requires owner reopening', async t => {
  const f = fixture(t, { loseReceipt: true }), first = await startPlayableXiangqi(f.host);
  t.after(() => first.stop());
  const opened = await first.actions['xiangqi.open']({}, f.caller), page = await browser(opened, first);
  await page.move();
  await eventually(async () => (await page.state()).delivery.status === 'error');
  await first.stop({ reason: 'disabled' });
  const second = await startPlayableXiangqi(f.host);
  t.after(() => second.stop());
  assert.equal(f.sends.length, 1, 'disabled pending work must not be replayed');
  await assert.rejects(second.actions['xiangqi.read']({ gameId: opened.gameId, revision: 1 }, f.caller), /不匹配/);
  await assert.rejects(browser(opened, second), /停用/);
  const reopened = await second.actions['xiangqi.open']({ gameId: opened.gameId }, f.caller);
  assert.equal(reopened.revision, 1);
  assert.equal(reopened.needsCompanionMove, true);
  assert.equal(f.sends.length, 1);
  assert.equal((await (await browser(reopened, second)).state()).history.length, 1);
});

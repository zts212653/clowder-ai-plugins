import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
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
        assert.deepEqual(input.payload.provenance.origin, { kind: 'plugin', instanceId: host.pluginInstanceId },
          'a local board event is authored by this installed plugin, not an undeclared external connector');
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
  assert.equal(redirect.status, 200, 'C1 webhooks permit relative redirects only; opening a separate board requires an explicit link');
  assert.equal(redirect.headers.location, undefined);
  opened = { ...opened, url: /id="open-board" href="([^"]+)"/.exec(redirect.body)?.[1] };
  const url = new URL(opened.url), origin = url.origin;
  // Node's OS resolver need not implement reserved *.localhost names. Connect
  // to loopback while preserving the actual browser Host/Origin contract.
  const request = (path, options = {}) => new Promise((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${url.port}${path}`,
      { method: options.method, headers: { host: url.host, ...options.headers } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(new Response(Buffer.concat(chunks),
          { status: response.statusCode, headers: response.headers })));
        response.on('error', reject);
      });
    req.on('error', reject); req.end(options.body);
  });
  const secret = new URLSearchParams(url.hash.slice(1)).get('session');
  const exchange = await request('/api/session', { method: 'POST', headers: { origin, authorization: `Bearer ${secret}` } });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  assert.equal(exchange.headers.get('set-cookie'), null, 'a sibling loopback port must not receive a game cookie');
  const authorization = `Bearer ${(await exchange.json()).session}`;
  const state = async () => {
    const response = await request('/api/state', { headers: { authorization } });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { origin, authorization, secret, state, request,
    async move() {
      const current = await state();
      const response = await request('/api/move', { method: 'POST',
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
  for (let retry = 0; retry < 20; retry++)
    assert.equal((await runtime.actions['xiangqi.open']({}, f.caller)).gameId, opened.gameId,
      'reopening from chat must not consume the browser launch allowance');
  const page = await browser(opened, runtime);
  await assert.rejects(browser(opened, runtime, 'other-owner'), /不属于/);
  assert.equal((await page.request('/api/state')).status, 403);
  const replay = await page.request('/api/session', { method: 'POST', headers: { origin: page.origin, authorization: `Bearer ${page.secret}` } });
  assert.equal(replay.status, 403, 'launch bearers are one use');
  const crossOrigin = await page.request('/api/state', { headers: { origin: 'https://foreign.invalid', authorization: page.authorization } });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await page.move()).revision, 1);
  await eventually(() => f.sends.length === 1);
  await eventually(async () => (await page.state()).delivery.status !== 'pending');
  assert.equal((await page.state()).delivery.status, 'accepted');
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
  const beforeUndo = await page.state();
  const undone = await page.request('/api/undo', { method: 'POST',
    headers: { origin: page.origin, authorization: page.authorization, 'content-type': 'application/json', 'x-chess-token': beforeUndo.token },
    body: JSON.stringify({ revision: beforeUndo.revision }) });
  assert.equal(undone.status, 200);
  await assert.rejects(runtime.actions['xiangqi.play']({ gameId: opened.gameId, revision: 1, move }, f.caller), /版本冲突/);
  await runtime.stop();
  assert.equal(readGame(join(f.root, 'games'), opened.gameId).revision, 3);
  await assert.rejects(page.request('/api/state'));
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

test('ordinary owner invocation opens from its authenticated origin without optional wait metadata', async t => {
  const f = fixture(t), runtime = await startPlayableXiangqi(f.host);
  t.after(() => runtime.stop());
  const caller = { ...f.caller, source: undefined, originTriggerMessageId: 'real-human-origin' };
  let requested;
  const get = f.host.messaging.get;
  f.host.messaging.get = async id => { requested = id; return get(id); };
  assert.equal((await runtime.actions['xiangqi.open']({}, caller)).revision, 0);
  assert.equal(requested, 'real-human-origin');
  await assert.rejects(runtime.actions['xiangqi.open']({}, { ...caller, originTriggerMessageId: undefined }), /人类.*请求/);
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

test('concurrent owner launches after restart share one tracked board', async t => {
  const f = fixture(t), first = await startPlayableXiangqi(f.host);
  t.after(() => first.stop());
  const opened = await first.actions['xiangqi.open']({}, f.caller);
  await first.stop({ reason: 'host-shutdown' });
  const runtime = await startPlayableXiangqi(f.host);
  t.after(() => runtime.stop());
  const request = { request: { method: 'GET', path: `board/${opened.gameId}`, principal: { id: 'owner-a' } } };
  const owner = { kind: 'owner-http-request', operation: 'read', userId: 'owner-a', pluginInstanceId: 'installed-a',
    signal: new AbortController().signal, async assertCurrent() {} };
  const launches = await Promise.all(Array.from({ length: 16 }, () => runtime.actions['xiangqi.launch'](request, undefined, owner)));
  assert.equal(new Set(launches.map(result => new URL(/id="open-board" href="([^"]+)"/.exec(result.body)[1]).origin)).size, 1);
});

for (const operation of ['undo', 'restart']) test(`${operation} clears delivery failure for the discarded move`, async t => {
  const f = fixture(t, { loseReceipt: true }), runtime = await startPlayableXiangqi(f.host);
  t.after(() => runtime.stop());
  const page = await browser(await runtime.actions['xiangqi.open']({}, f.caller), runtime);
  await page.move();
  await eventually(async () => (await page.state()).delivery.status === 'error');
  const current = await page.state();
  const result = await page.request(`/api/${operation}`, { method: 'POST',
    headers: { origin: page.origin, authorization: page.authorization, 'content-type': 'application/json', 'x-chess-token': current.token },
    body: JSON.stringify({ revision: current.revision, ...(operation === 'restart' ? { confirmed: true } : {}) }) });
  assert.equal(result.status, 200);
  assert.equal((await page.state()).history.length, 0);
  assert.equal((await page.state()).delivery.status, 'idle');
});

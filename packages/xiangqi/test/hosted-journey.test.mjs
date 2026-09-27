import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHostedBoard } from '../src/board-server.mjs';
import { createHostedGame } from '../src/hosted-game.mjs';
import { createGame, readCurrentAnalysis, readGame, undoGame } from '../src/store.mjs';

function fixture(t, identity, destination, humanName, companionName) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'xiangqi-host-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const gameId = 'fixture-game';
  createGame(dataRoot, gameId);
  const session = Object.freeze({ dataRoot, gameId, humanName, companionName });
  let caller = identity;
  let humanAllowed = true;
  const deliveries = [];
  let status = { status: 'idle' };
  const host = {
    openSession: () => session,
    deliveryStatus: () => status,
    async authorizeHumanAction() {
      if (!humanAllowed) throw new Error('human grant revoked');
    },
    async authorizeCandidateRead() {
      if (caller !== identity) throw new Error('wrong companion');
    },
    async authorizeCompanionMove() {
      if (caller !== identity) throw new Error('wrong companion');
    },
    async notifyConfirmedMove(_session, event) {
      deliveries.push({ ...event, destination, companion: identity });
      status = { status: 'accepted' };
    },
    async retryPending() {
      status = { status: 'accepted' };
    },
  };
  return {
    dataRoot, gameId, identity, destination, host, deliveries,
    callAs(principal) { caller = principal; },
    revokeHuman() { humanAllowed = false; },
  };
}

async function launch(board, t) {
  const app = createHostedBoard({
    host: board.host,
    prepare: () => ({ done: Promise.resolve({ ok: true }), cancel() {} }),
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const state = await (await fetch(`${base}/api/state`)).json();
  return {
    base,
    state,
    post: (route, body) => fetch(`${base}/api/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-chess-token': state.token },
      body: JSON.stringify(body),
    }),
  };
}

test('two Host-bound games keep identity, destination, root and revision separate', async (t) => {
  const first = fixture(t, 'cat-alpha', 'conversation-alpha', 'Player A', 'Partner A');
  const second = fixture(t, 'cat-beta', 'conversation-beta', 'Player B', 'Partner B');
  const a = await launch(first, t);
  const b = await launch(second, t);
  assert.equal(a.state.players.companion, 'Partner A');
  assert.equal(b.state.players.companion, 'Partner B');
  assert.equal((await a.post('move', { move: 'b2e2', revision: 0 })).status, 400);
  assert.equal(first.deliveries.length, 0);
  const postedA = await a.post('move', { move: 'b2e2', revision: 0, confirmed: true });
  assert.equal(postedA.status, 200, await postedA.text());
  const postedB = await b.post('move', { move: 'b2e2', revision: 0, confirmed: true });
  assert.equal(postedB.status, 200, await postedB.text());
  assert.deepEqual(first.deliveries.map((item) => [item.destination, item.companion]), [
    ['conversation-alpha', 'cat-alpha'],
  ]);
  assert.deepEqual(second.deliveries.map((item) => [item.destination, item.companion]), [
    ['conversation-beta', 'cat-beta'],
  ]);
  const gameA = createHostedGame(first.host);
  const gameB = createHostedGame(second.host);
  first.callAs('cat-beta');
  await assert.rejects(() => gameA.candidates(1), /wrong companion/);
  first.callAs('cat-alpha');
  const candidatesA = await gameA.candidates(1, { timeMs: 30, maxDepth: 2 });
  const candidatesB = await gameB.candidates(1, { timeMs: 30, maxDepth: 2 });
  assert.equal(candidatesA.revision, 1);
  assert.equal(candidatesB.revision, 1);
  assert.equal(candidatesA.candidates.length > 0, true);
  const choice = candidatesA.candidates[0].ucci;
  const played = await gameA.commitCompanionMove(choice, 1);
  assert.equal(played.moves.at(-1).actor, 'companion');
  assert.equal(readGame(first.dataRoot, first.gameId).revision, 2);
  assert.equal(readGame(second.dataRoot, second.gameId).revision, 1);
  await assert.rejects(() => gameA.candidates(1), /版本冲突/);
  undoGame(first.dataRoot, first.gameId, 2, 2);
  assert.equal(readCurrentAnalysis(first.dataRoot, first.gameId, 3), null);
  assert.equal(readGame(first.dataRoot, first.gameId).moves.length, 0);
  assert.equal(JSON.parse(readFileSync(join(second.dataRoot, 'fixture-game.json'))).revision, 1);
  first.revokeHuman();
  assert.equal((await fetch(`${a.base}/api/state`)).status, 400);
  assert.equal((await a.post('move', { move: 'b2e2', revision: 3, confirmed: true })).status, 400);
  assert.equal(readGame(first.dataRoot, first.gameId).revision, 3);
});

test('reopening a board preserves the journal and does not replay a confirmed move', async (t) => {
  const binding = fixture(t, 'cat-gamma', 'conversation-gamma', 'Player C', 'Partner C');
  const first = await launch(binding, t);
  assert.equal((await first.post('move', { move: 'b2e2', revision: 0, confirmed: true })).status, 200);
  assert.equal(binding.deliveries.length, 1);
  const original = readFileSync(join(binding.dataRoot, 'fixture-game.json'));
  const reopened = await launch(binding, t);
  assert.equal(reopened.state.revision, 1);
  assert.deepEqual(readFileSync(join(binding.dataRoot, 'fixture-game.json')), original);
  assert.equal(binding.deliveries.length, 1);
});

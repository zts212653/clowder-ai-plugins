import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostedBoard } from '../src/board-server.mjs';
import { createHostedGame } from '../src/hosted-game.mjs';
import { parseFen } from '../src/rules.mjs';
import { createGame, durableWrite, readGame } from '../src/store.mjs';

const hostOrigin = process.env.F170_PREVIEW_HOST_ORIGIN ?? 'http://localhost:5172';
const controlPort = Number(process.env.F170_PREVIEW_CONTROL_PORT ?? 5719);
const dataRoot = process.env.F170_PREVIEW_DATA_ROOT ?? mkdtempSync(join(tmpdir(), 'f170-preview-'));
const definitions = [
  { id: 'amber', humanName: '体验者', companionName: '橙猫', conversation: '练习会话 A' },
  { id: 'teal', humanName: '体验者', companionName: '青猫', conversation: '练习会话 B' },
];

function binding(definition) {
  const gameId = `preview-${definition.id}`;
  const root = join(dataRoot, definition.id);
  const session = Object.freeze({
    dataRoot: root,
    gameId,
    humanName: definition.humanName,
    companionName: definition.companionName,
    bindingGeneration: `synthetic-${definition.id}-1`,
    allowedOrigins: [hostOrigin],
  });
  try { readGame(root, gameId); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    createGame(root, gameId);
  }
  const receiptFile = join(root, 'synthetic-host-receipts.json');
  const receipts = new Map(existsSync(receiptFile) ? Object.entries(JSON.parse(readFileSync(receiptFile, 'utf8'))) : []);
  let delivery = { status: receipts.size ? 'accepted' : 'idle' };
  let failAfterAccept = false;
  const host = {
    openSession: () => session,
    async authorizeHumanAction(_session, operation, projection) {
      if (operation !== 'move') return;
      // Preview-only stand-in: the real Host must sign this after its own authenticated UI action.
      return {
        ...projection,
        bindingGeneration: session.bindingGeneration,
        actionId: `synthetic-${definition.id}-${readGame(root, gameId).revision}`,
      };
    },
    async authorizeCandidateRead() {},
    async authorizeCompanionMove() {},
    deliveryStatus: () => delivery,
    async notifyConfirmedMove(_session, event) {
      const previous = receipts.get(event.actionId);
      if (previous && previous.operationDigest !== event.operationDigest) throw Error('actionId content changed');
      const receipt = previous ?? {
        actionId: event.actionId,
        operationDigest: event.operationDigest,
        receiptId: `synthetic-receipt-${event.actionId}`,
      };
      receipts.set(event.actionId, receipt);
      if (!previous) durableWrite(receiptFile, Object.fromEntries(receipts));
      if (failAfterAccept) {
        failAfterAccept = false;
        delivery = { status: 'error' };
        throw Error('模拟：Host 已接纳，收据返回前连接中断');
      }
      delivery = { status: 'accepted' };
      return receipt;
    },
    async retryPending() { delivery = { status: receipts.size ? 'accepted' : 'idle' }; },
  };
  let board;
  let boardPort;
  const open = async () => {
    board = createHostedBoard({ host, prepare: () => ({ done: Promise.resolve({ ok: true }), cancel() {} }) });
    await new Promise((resolve) => board.listen(boardPort ?? 0, '127.0.0.1', resolve));
    boardPort = board.address().port;
  };
  return {
    definition, host, session, root, gameId, open,
    boardUrl: () => `http://127.0.0.1:${boardPort}/`,
    status: () => {
      const game = readGame(root, gameId);
      return {
        id: definition.id,
        humanName: definition.humanName,
        companionName: definition.companionName,
        conversation: definition.conversation,
        boardUrl: `http://127.0.0.1:${boardPort}/`,
        revision: game.revision,
        plies: game.moves.length,
        companionToMove: game.result.status === 'playing' && parseFen(game.fen).turn !== game.humanSide,
        delivery,
        durableReceipts: receipts.size,
      };
    },
    failNext() { failAfterAccept = true; },
    async reopen() {
      await new Promise((resolve) => board.close(resolve));
      delivery = { status: 'pending' };
      await open();
    },
    async choose() {
      const game = readGame(root, gameId);
      if (game.result.status !== 'playing' || parseFen(game.fen).turn === game.humanSide)
        throw Error('当前没有待应招的棋步');
      const companion = createHostedGame(host);
      const report = await companion.candidates(game.revision, { timeMs: 100, maxDepth: 3 });
      const move = report.candidates[0]?.ucci;
      if (!move) throw Error('当前无合法候选');
      const saved = await companion.commitCompanionMove(move, game.revision);
      return { chosen: move, revision: saved.revision, candidates: report.candidates.length };
    },
    close: () => new Promise((resolve) => board.close(resolve)),
  };
}

const bindings = Object.fromEntries(definitions.map((definition) => [definition.id, binding(definition)]));
for (const item of Object.values(bindings)) await item.open();
const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  const localOrigin = !origin || /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/.test(origin);
  const send = (status, body) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': localOrigin && origin ? origin : hostOrigin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
  };
  if (!localOrigin) return send(403, { error: 'Origin 不被允许' });
  if (req.method === 'OPTIONS') return send(204, {});
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && path === '/bindings') return send(200, Object.values(bindings).map((item) => item.status()));
  const match = /^\/bindings\/(amber|teal)\/(fail-next|reopen|choose)$/.exec(path);
  if (!match || req.method !== 'POST') return send(404, { error: '未找到' });
  try {
    const item = bindings[match[1]];
    let result = {};
    if (match[2] === 'fail-next') item.failNext();
    if (match[2] === 'reopen') await item.reopen();
    if (match[2] === 'choose') result = await item.choose();
    return send(200, { ...result, binding: item.status() });
  } catch (error) {
    return send(409, { error: error.message });
  }
});
await new Promise((resolve) => server.listen(controlPort, '127.0.0.1', resolve));
console.log(`F170 synthetic preview control: http://127.0.0.1:${controlPort}`);
console.log(`F170 synthetic data root: ${dataRoot}`);
for (const item of Object.values(bindings)) console.log(`${item.definition.id}: ${item.boardUrl()}`);
process.on('SIGINT', async () => {
  server.close();
  await Promise.all(Object.values(bindings).map((item) => item.close()));
  process.exit(0);
});

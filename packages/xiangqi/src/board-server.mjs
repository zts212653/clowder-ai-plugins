import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatMove, ucci } from './notation.mjs';
import { startPreparedAnalysis } from './prepare.mjs';
import { isCheck, legalMoves, parseFen } from './rules.mjs';
import { playGame, readGame, undoGame } from './store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/client.mjs': ['client.mjs', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/panels.css': ['panels.css', 'text/css; charset=utf-8'],
};
function fail(status, message) {
  return Object.assign(new Error(message), { status });
}
async function jsonBody(req) {
  if (req.headers['content-type'] !== 'application/json') throw fail(415, '请发送 JSON');
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 4096) throw fail(413, '请求过大');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw fail(400, '无效 JSON');
  }
}
/**
 * Host-only adapter. The Host chooses the retained data root and the selected
 * companion/conversation before opening this board. Browser requests cannot
 * set those authorities. The current public Host does not yet mount this UI.
 */
export function createHostedBoard({ host, prepare = startPreparedAnalysis }) {
  const session = host.openSession();
  const { dataRoot: root, gameId, humanName, companionName } = session;
  if (
    !root ||
    !gameId ||
    !humanName ||
    !companionName ||
    typeof host.notifyConfirmedMove !== 'function' ||
    typeof host.deliveryStatus !== 'function' ||
    typeof host.retryPending !== 'function' ||
    typeof host.authorizeHumanAction !== 'function'
  ) throw new TypeError('Host did not provide a complete chess session');
  readGame(root, gameId);
  const token = randomBytes(24).toString('hex');
  let preparation = null;
  const cancelPreparation = () => {
    preparation?.cancel();
    preparation = null;
  };
  function view() {
    const g = readGame(root, gameId),
      p = parseFen(g.fen),
      human = p.turn === g.humanSide;
    return {
      id: g.id,
      revision: g.revision,
      turn: p.turn,
      humanSide: g.humanSide,
      board: p.board,
      result: g.result,
      inCheck: isCheck(p),
      token,
      players: { human: humanName, companion: companionName },
      legalMoves:
        human && g.result.status === 'playing'
          ? legalMoves(p).map((m) => ({ ...m, ucci: ucci(m), notation: formatMove(p, m) }))
          : [],
      history: g.moves.map((m) => ({ notation: m.notation, side: m.side, ucci: m.ucci })),
      lastMove: g.moves.at(-1)?.ucci ?? null,
      delivery: host.deliveryStatus(session),
    };
  }
  const app = createServer(async (req, res) => {
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    try {
      const port = app.address().port,
        requestHost = req.headers.host;
      const directOrigins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
      if (!directOrigins.some((o) => new URL(o).host === requestHost)) throw fail(403, 'Host 不被允许');
      const allowed = new Set([...directOrigins, ...(session.allowedOrigins ?? [])]);
      if (req.headers.origin && !allowed.has(req.headers.origin)) throw fail(403, 'Origin 不被允许');
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/api/state') {
        await host.authorizeHumanAction(session, 'read');
        return send(200, view());
      }
      if (req.method === 'GET' && staticFiles[path]) {
        const [file, type] = staticFiles[path];
        const content = readFileSync(resolve(here, 'web', file));
        return send(200, content.toString(), type);
      }
      if (
        req.method !== 'POST' ||
        !['/api/move', '/api/undo', '/api/restart', '/api/retry'].includes(path)
      )
        return send(404, { error: '未找到' });
      if (!req.headers.origin || req.headers['x-chess-token'] !== token) throw fail(403, '页面凭据无效，请刷新');
      const body = await jsonBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, '无效请求');
      const needsConfirmation = path === '/api/move' || path === '/api/restart';
      const keys =
        path === '/api/move'
          ? ['move', 'revision', 'confirmed']
          : path === '/api/restart'
            ? ['revision', 'confirmed']
          : ['revision'];
      if (Object.keys(body).some((k) => !keys.includes(k))) throw fail(400, '请求包含不支持的字段');
      if (needsConfirmation && body.confirmed !== true) throw fail(400, '请刷新页面，点击确认按钮后再提交');
      const g = readGame(root, gameId);
      if (!Number.isInteger(body.revision) || body.revision !== g.revision) throw fail(409, '棋盘已变化，请刷新后再走');
      await host.authorizeHumanAction(session, path.slice('/api/'.length));
      if (path === '/api/move') {
        if (parseFen(g.fen).turn !== g.humanSide) throw fail(409, '现在等棋搭子应招');
        if (typeof body.move !== 'string' || body.move.length > 30) throw fail(400, '无效棋步');
        const saved = playGame(root, gameId, body.move, {
          actor: 'human',
          expectedRevision: g.revision,
          origin: 'board',
        });
        cancelPreparation();
        if (saved.result.status === 'playing') {
          try {
            preparation = prepare(root, gameId, saved.revision);
            void preparation.done?.then((result) => {
              if (!result.ok && result.error !== 'cancelled') console.error('预分析异常:', result.error);
            });
          } catch (error) {
            console.error('预分析未启动:', error.message);
          }
        }
        void host.notifyConfirmedMove(session, {
          gameId,
          revision: saved.revision,
          notation: saved.moves.at(-1).notation,
          ucci: saved.moves.at(-1).ucci,
        }).catch((e) => console.error('通知异常:', e.message));
      } else if (path === '/api/restart') {
        cancelPreparation();
        if (g.moves.length) undoGame(root, gameId, g.moves.length, g.revision);
      } else if (path === '/api/undo') {
        if (!g.moves.length) throw fail(409, '尚未落子');
        cancelPreparation();
        const plies = g.moves.at(-1).actor === 'companion' && g.moves.length >= 2 ? 2 : 1;
        undoGame(root, gameId, plies, g.revision);
      } else await host.retryPending(session);
      send(200, view());
    } catch (error) {
      send(error.status ?? 400, { error: error.message });
    }
  });
  app.requestTimeout = 15000;
  app.headersTimeout = 10000;
  app.on('close', () => {
    cancelPreparation();
  });
  return app;
}

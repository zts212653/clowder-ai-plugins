import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHostedBoard } from './board-server.mjs';
import { createBrowserSession } from './browser-session.mjs';
import { createHostedGame } from './hosted-game.mjs';
import { dispatchConfirmedActions } from './notification-recovery.mjs';
import { parseFen } from './rules.mjs';
import { createGame, durableWrite, readGame } from './store.mjs';

export function createGameRuntime(root, hostCall) {
  mkdirSync(root, { recursive: true });
  const boards = new Map();
  const deliveries = new Map();
  let stopped = false;
  const active = () => { if (stopped) throw new Error('棋桌已停用'); };
  const metadataPath = id => {
    if (typeof id !== 'string' || !/^game_[a-f0-9]{32}$/.test(id)) throw new Error('无效棋局编号');
    return join(root, `${id}.binding.json`);
  };
  const binding = id => JSON.parse(readFileSync(metadataPath(id), 'utf8'));
  function adapter(meta, boardHostname) {
    const session = { ...meta, dataRoot: root, bindingGeneration: meta.generation,
      ...(boardHostname ? { boardHostname } : {}) };
    return {
      openSession: () => session,
      authorizeCandidateRead: async () => { active(); },
      authorizeCompanionMove: async () => { active(); },
      async authorizeHumanAction(_session, action, projection) {
        active();
        if (action !== 'move') return;
        // Request middleware has authenticated the owner-delegated browser session.
        return { ...projection, actionId: randomUUID(), bindingGeneration: meta.generation };
      },
      async notifyConfirmedMove(_session, event) {
        active();
        if (binding(meta.gameId).generation !== event.bindingGeneration) throw new Error('旧棋桌授权已撤销');
        deliveries.set(meta.gameId, { status: 'pending', actionId: event.actionId });
        try {
          const receipt = await hostCall('notify', { binding: meta, event });
          active();
          deliveries.set(meta.gameId, { status: 'accepted', actionId: event.actionId });
          return receipt;
        } catch (error) {
          deliveries.set(meta.gameId, { status: 'error', actionId: event.actionId });
          throw error;
        }
      },
      deliveryStatus: () => {
        const delivery = deliveries.get(meta.gameId);
        if (!delivery || !readGame(root, meta.gameId).moves.some(move => move.confirmedAction?.actionId === delivery.actionId)) {
          deliveries.delete(meta.gameId);
          return { status: 'idle' };
        }
        return { status: delivery.status };
      },
      retryPending: async () => {},
    };
  }
  return {
    binding,
    async recover() {
      for (const name of readdirSync(root).filter(value => /^game_[a-f0-9]{32}\.binding\.json$/.test(value))) {
        const meta = JSON.parse(readFileSync(join(root, name), 'utf8'));
        if (meta.revoked) continue;
        const host = adapter(meta);
        await dispatchConfirmedActions(root, meta.gameId, meta.generation, host.openSession(), host).catch(() => {});
      }
    },
    async open(input) {
      active();
      const { gameId } = input;
      const identity = Object.fromEntries(['userId', 'threadId', 'catId', 'humanName', 'companionName'].map(key => [key, input[key]]));
      let id = gameId;
      if (!id) {
        const retained = readdirSync(root).filter(value => /^game_[a-f0-9]{32}\.binding\.json$/.test(value))
          .map(name => JSON.parse(readFileSync(join(root, name), 'utf8')))
          .find(meta => meta.userId === identity.userId && meta.threadId === identity.threadId && meta.catId === identity.catId &&
            readGame(root, meta.gameId).result.status === 'playing');
        id = retained?.gameId ?? `game_${randomUUID().replaceAll('-', '')}`;
      }
      const path = metadataPath(id);
      let meta;
      if (existsSync(path)) {
        meta = binding(id);
        for (const key of ['userId', 'threadId', 'catId'])
          if (meta[key] !== identity[key]) throw new Error('这盘棋属于另一位棋搭子或对话');
        if (meta.revoked) {
          meta = { ...meta, revoked: false, generation: randomUUID() };
          durableWrite(path, meta);
        }
      } else {
        meta = { ...identity, gameId: id, generation: randomUUID(), revoked: false };
        createGame(root, id);
        durableWrite(path, meta, true);
      }
      let opening = boards.get(id);
      if (!opening) {
        if (boards.size >= 8) throw new Error('已有八张棋桌运行；请回到已有棋盘，或在插件设置重新启用棋桌，存档会保留');
        opening = (async () => {
          const browser = createBrowserSession();
          const hostname = `xq-${randomUUID().replaceAll('-', '')}.localhost`;
          const host = adapter(meta, hostname);
          host.handleRequest = (_session, req, res) => browser.handle(req, res);
          const server = createHostedBoard({ host });
          await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
          });
          return { server, browser, hostname };
        })();
        boards.set(id, opening);
        opening.catch(() => { if (boards.get(id) === opening) boards.delete(id); });
      }
      const board = await opening;
      active();
      const game = readGame(root, id);
      return { gameId: id, revision: game.revision,
        needsCompanionMove: game.result.status === 'playing' && parseFen(game.fen).turn !== game.humanSide,
        ...(input.browserLaunch ? { url: `http://${board.hostname}:${board.server.address().port}/#session=${board.browser.launch()}` } : {}),
        companionName: meta.companionName };
    },
    async candidates({ gameId, revision, timeMs = 1000, maxDepth = 5 }) {
      active();
      return createHostedGame(adapter(binding(gameId))).candidates(revision, { timeMs, maxDepth });
    },
    async play({ gameId, revision, move }) {
      active();
      const game = readGame(root, gameId);
      const prior = game.events[revision]?.record;
      if (game.revision === revision + 1 && prior?.actor === 'companion' && prior.ucci === move)
        return { gameId, revision: revision + 1, duplicate: true };
      const saved = await createHostedGame(adapter(binding(gameId))).commitCompanionMove(move, revision);
      return { gameId, revision: saved.revision, lastMove: saved.moves.at(-1)?.ucci };
    },
    async stop({ revoke = true } = {}) {
      if (stopped) return;
      stopped = true;
      if (revoke) {
        for (const name of readdirSync(root).filter(value => /^game_[a-f0-9]{32}\.binding\.json$/.test(value))) {
          const path = join(root, name), meta = JSON.parse(readFileSync(path, 'utf8'));
          durableWrite(path, { ...meta, revoked: true });
        }
      }
      await Promise.all([...boards.values()].map(async opening => {
        const board = await opening.catch(() => null);
        if (board) await new Promise(resolve => {
          board.server.close(resolve); board.server.closeAllConnections();
        });
      }));
      boards.clear();
    },
  };
}

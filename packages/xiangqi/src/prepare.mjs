import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { isCheck, legalMoves, parseFen } from './rules.mjs';
import { analyzeGame, readGame } from './store.mjs';

export function decisionBudget(position) {
  return isCheck(position) || legalMoves(position).length <= 4 ? 10000 : 3000;
}

export function startPreparedAnalysis(root, id, expectedRevision) {
  const game = readGame(root, id);
  if (game.revision !== expectedRevision || game.result.status !== 'playing')
    throw new Error('棋局已变化或终局，不能预分析');
  const position = parseFen(game.fen);
  const worker = new Worker(new URL('./prepare.mjs', import.meta.url), {
    execArgv: [],
    workerData: {
      root,
      id,
      expectedRevision,
      fen: game.fen,
      timeMs: decisionBudget(position),
      maxDepth: 7,
      queuedAt: new Date().toISOString(),
    },
  });
  let cancelled = false;
  const done = new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    worker.on('message', finish);
    worker.on('error', (error) => finish({ ok: false, error: error.message }));
    worker.on('exit', (code) => {
      if (!settled) finish({ ok: false, error: cancelled ? 'cancelled' : `worker exited ${code}` });
    });
  });
  return {
    done,
    cancel() {
      cancelled = true;
      void worker.terminate();
    },
  };
}

if (!isMainThread) {
  try {
    const { root, id, expectedRevision, fen, timeMs, maxDepth, queuedAt } = workerData;
    const game = readGame(root, id);
    if (game.revision !== expectedRevision || game.fen !== fen) throw new Error('预分析开始前棋盘已变化');
    const report = analyzeGame(root, id, { timeMs, maxDepth, source: 'board-precompute', queuedAt });
    parentPort.postMessage({ ok: true, analysisFile: report.analysisFile, revision: report.positionRevision });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error.message });
  }
}

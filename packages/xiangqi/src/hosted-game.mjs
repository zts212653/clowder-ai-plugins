import { isCheck, legalMoves, parseFen } from './rules.mjs';
import { analyzeGame, playGame, readCurrentAnalysis, readGame } from './store.mjs';

/**
 * A Host-bound game facade. The caller supplies no identity or data path per
 * operation: those come from one Host-issued session. This library is not an
 * authentication system; the Host must authorize each invoking principal.
 */
export function createHostedGame(host) {
  if (
    typeof host.openSession !== 'function' ||
    typeof host.authorizeCandidateRead !== 'function' ||
    typeof host.authorizeCompanionMove !== 'function'
  ) throw new TypeError('Host session and authorization methods are required');
  const session = host.openSession();
  const { dataRoot, gameId } = session ?? {};
  if (typeof dataRoot !== 'string' || typeof gameId !== 'string') throw new TypeError('Host session is incomplete');
  readGame(dataRoot, gameId);

  return {
    async candidates(expectedRevision, options = {}) {
      await host.authorizeCandidateRead(session);
      const game = readGame(dataRoot, gameId);
      if (game.revision !== expectedRevision) throw new Error('棋局版本冲突');
      const position = parseFen(game.fen);
      const timeMs = options.timeMs ?? (isCheck(position) || legalMoves(position).length <= 4 ? 10000 : 3000);
      const maxDepth = options.maxDepth ?? 7;
      const report = readCurrentAnalysis(dataRoot, gameId, expectedRevision) ??
        analyzeGame(dataRoot, gameId, { timeMs, maxDepth, source: 'host-read' });
      return {
        gameId,
        revision: game.revision,
        fen: game.fen,
        sideToMove: position.turn,
        result: game.result,
        inCheck: isCheck(position),
        prepared: report.source === 'board-precompute',
        searchVersion: report.searchVersion,
        completedDepth: report.completedDepth,
        timedOut: report.timedOut,
        candidates: report.candidates,
      };
    },
    async commitCompanionMove(move, expectedRevision) {
      await host.authorizeCompanionMove(session);
      return playGame(dataRoot, gameId, move, { actor: 'companion', expectedRevision });
    },
  };
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { formatMove, ucci } from './notation.mjs';
import { isCheck, legalMoves, outcome, parseFen } from './rules.mjs';
import { analyze } from './search.mjs';

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function errorResult(error) {
  return {
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export function createXiangqiMcpServer({ actionClient, apiUrl = process.env.CAT_CAFE_API_URL } = {}) {
  const server = new McpServer({ name: 'clowder-xiangqi', version: '0.1.0' });
  server.registerTool(
    'xiangqi_legal_moves',
    {
      title: 'Xiangqi legal moves',
      description: 'List legal moves and terminal state for a supplied Xiangqi FEN. This tool does not open or modify a game.',
      inputSchema: { fen: z.string().min(1).max(300) },
      annotations: { readOnlyHint: true },
    },
    async ({ fen }) => {
      try {
        const position = parseFen(fen);
        return textResult({
          fen,
          sideToMove: position.turn,
          inCheck: isCheck(position),
          result: outcome(position),
          moves: legalMoves(position).map((move) => ({
            ucci: ucci(move),
            notation: formatMove(position, move),
          })),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  server.registerTool(
    'xiangqi_analyze_position',
    {
      title: 'Xiangqi position analysis',
      description: 'Analyze a supplied Xiangqi FEN using a local search. Candidates are advice, never an automatic move or a win probability.',
      inputSchema: {
        fen: z.string().min(1).max(300),
        timeMs: z.number().int().min(1).max(10000).optional(),
        maxDepth: z.number().int().min(1).max(7).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ fen, timeMs, maxDepth }) => {
      try {
        const report = analyze(parseFen(fen), { timeMs: timeMs ?? 3000, maxDepth: maxDepth ?? 5 });
        return textResult({
          fen: report.fen,
          sideToMove: report.side,
          terminal: report.terminal,
          safetyComplete: report.safetyComplete,
          elapsedMs: report.elapsedMs,
          searchBudgetMs: report.searchBudgetMs,
          completedDepth: report.completedDepth,
          timedOut: report.timedOut,
          scoreMeaning: report.scoreMeaning,
          searchVersion: report.searchVersion,
          candidates: report.candidates.slice(0, 8),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  const invoke = async (method, input, extra) => {
    try {
      actionClient ??= (await import('@clowder-ai/plugin-sdk')).createModuleActionClient();
      const result = await actionClient.invoke(method, input, { _meta: extra?._meta, signal: extra?.signal });
      if (method === 'xiangqi.open') {
        const origin = new URL(apiUrl);
        if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
          !/^\/api\/plugins\/dev\.clowder\.xiangqi\/board\/game_[a-f0-9]{32}$/.test(result.launchPath))
          throw new Error('宿主棋盘入口地址不可用');
        return textResult({ ...result, url: new URL(result.launchPath, origin).href });
      }
      return textResult(result);
    } catch (error) { return errorResult(error); }
  };
  const gameId = z.string().regex(/^game_[a-f0-9]{32}$/).describe('Retained game ID returned by xiangqi_open_game.');
  const revision = z.number().int().nonnegative().describe('Exact game revision returned by the board, notification or a previous game tool.');
  server.registerTool('xiangqi_open_game', {
    title: 'Open a chess game with the current cat',
    description: 'Open or resume a retained game with this cat. Use when a human asks to play Chinese chess / 开一盘象棋 in this conversation. Not for plugin wake messages or analysis of a supplied FEN. Output: game ID, revision and an owner-authenticated board URL; give the human a clickable link. If needsCompanionMove is true, read candidates and personally submit your reply. Caller identity is supplied only by the Host.',
    inputSchema: { gameId: gameId.optional() },
  }, (input, extra) => invoke('xiangqi.open', input, extra));
  server.registerTool('xiangqi_read_game', {
    title: 'Read the current game and candidates',
    description: 'Read a retained game at its exact revision. Use after a confirmed human move notification or before choosing your reply. Not for opening a board or playing a move. Output: current position and candidate moves for the bound cat in the bound conversation. Choose a move yourself, then call xiangqi_play_move; reading never plays automatically.',
    inputSchema: { gameId, revision, timeMs: z.number().int().min(1).max(10000).describe('Search budget in milliseconds, default 1000.').optional(), maxDepth: z.number().int().min(1).max(7).describe('Maximum search depth in plies, default 5.').optional() },
    annotations: { readOnlyHint: true },
  }, (input, extra) => invoke('xiangqi.read', input, extra));
  server.registerTool('xiangqi_play_move', {
    title: 'Submit the current cat\'s chosen move',
    description: 'Commit this cat\'s personally chosen UCCI move. Use after reading candidates for the same game and revision. Not for human moves, opening games or automatic candidate selection. Output: the committed revision and last move, immediately visible on the board. Stale revisions, wrong cat/thread, human turn and unsafe moves are rejected. After an uncertain result, read current state before retrying.',
    inputSchema: { gameId, revision, move: z.string().regex(/^[a-i][0-9][a-i][0-9]$/).describe('Your chosen UCCI move, for example b9c7.') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, (input, extra) => invoke('xiangqi.play', input, extra));
  return server;
}

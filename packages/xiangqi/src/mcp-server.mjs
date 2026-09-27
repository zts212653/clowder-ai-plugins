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

export function createXiangqiMcpServer() {
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
  return server;
}

import { performance } from 'node:perf_hooks';
import { formatMove, ucci } from './notation.mjs';
import {
  applyMove,
  hasLegalMove,
  isCheck,
  legalMoveIterator,
  legalMoves,
  outcome,
  pieceSide,
  playUnchecked,
  positionKey,
  toFen,
  xy,
} from './rules.mjs';

const VALUE = { r: 900, n: 420, c: 450, b: 210, a: 210, p: 100, k: 0 };
const MATE = 100000,
  TIMEOUT = Symbol('timeout');
export const SEARCH_VERSION = 'clowder-xiangqi-alpha-beta-v1';
export function evaluate(p) {
  let score = 0;
  for (let i = 0; i < 90; i++) {
    const piece = p.board[i];
    if (piece === '.') continue;
    const type = piece.toLowerCase(),
      side = pieceSide(piece),
      [x, y] = xy(i);
    const progress = side === 'red' ? 9 - y : y,
      center = 4 - Math.abs(4 - x);
    let bonus = 0;
    if (type === 'p') bonus = progress * 5 + (progress >= 5 ? 75 + center * 5 : 0);
    if (type === 'n') bonus = center * 9 + Math.min(progress, 6) * 5;
    if (type === 'r') bonus = center * 3 + Math.min(progress, 7) * 3;
    if (type === 'c') bonus = center * 3 + Math.min(progress, 6) * 2;
    score += (side === 'red' ? 1 : -1) * (VALUE[type] + bonus);
  }
  return score * (p.turn === 'red' ? 1 : -1);
}
const describe = (p, m) => ({ ucci: ucci(m), notation: formatMove(p, m) });
export function auditMove(p, m) {
  const child = applyMove(p, m),
    winningReplies = [];
  const result = outcome(child);
  if (result.status === 'playing') {
    for (const reply of legalMoveIterator(child)) {
      const leaf = playUnchecked(child, reply);
      if (!hasLegalMove(leaf))
        winningReplies.push({ ...describe(child, reply), result: isCheck(leaf) ? 'checkmate' : 'stalemate' });
    }
  }
  return {
    givesCheck: isCheck(child),
    winsNow: result.status !== 'playing',
    losesInOne: winningReplies.length > 0,
    winningReplies,
  };
}
function ordered(p, moves, preferred) {
  const priority = (m) => {
    if (preferred && ucci(m) === preferred) return 100000;
    const victim = p.board[m.to],
      attacker = p.board[m.from].toLowerCase();
    return victim === '.' ? 0 : VALUE[victim.toLowerCase()] * 16 - VALUE[attacker];
  };
  return moves.sort((a, b) => priority(b) - priority(a));
}
function tick(ctx) {
  ctx.nodes++;
  if (performance.now() >= ctx.deadline) throw TIMEOUT;
}
export function quiescence(p, alpha, beta, ply, left, ctx, quietChecksLeft = 1) {
  tick(ctx);
  const moves = legalMoves(p);
  if (moves.length === 0) return { score: -MATE + ply, pv: [] };
  const check = isCheck(p),
    stand = evaluate(p);
  if (left <= 0) {
    ctx.quiescenceLimits++;
    if (!check) return { score: stand, pv: [] };
    // A checked king cannot stand pat. At the tactical depth cap, resolve at
    // least one legal evasion and evaluate the resulting non-check position.
    let best = -Infinity,
      pv = [];
    for (const move of ordered(p, moves)) {
      if (performance.now() >= ctx.deadline) throw TIMEOUT;
      const child = playUnchecked(p, move),
        score = hasLegalMove(child) ? -evaluate(child) : MATE - ply - 1;
      if (score > best) {
        best = score;
        pv = [ucci(move)];
      }
      alpha = Math.max(alpha, score);
      if (alpha >= beta) break;
    }
    return { score: best, pv };
  }
  if (!check && stand >= beta) return { score: stand, pv: [] };
  let best = check ? -Infinity : stand,
    pv = [];
  if (!check) alpha = Math.max(alpha, stand);
  const tactical = check
    ? moves
    : moves.filter((m) => p.board[m.to] !== '.' || (quietChecksLeft > 0 && isCheck(playUnchecked(p, m))));
  for (const m of ordered(p, tactical)) {
    const quietCheck = !check && p.board[m.to] === '.';
    const next = quiescence(
        playUnchecked(p, m),
        -beta,
        -alpha,
        ply + 1,
        left - 1,
        ctx,
        quietChecksLeft - Number(quietCheck),
      ),
      score = -next.score;
    if (score > best) {
      best = score;
      pv = [ucci(m), ...next.pv];
    }
    alpha = Math.max(alpha, score);
    if (alpha >= beta) break;
  }
  return { score: best, pv };
}
function negamax(p, depth, alpha, beta, ply, ctx, path) {
  tick(ctx);
  const key = positionKey(p),
    repeats = path.filter((k) => k === key).length;
  // Search-cycle heuristic only, never an official perpetual-check/chase verdict.
  if (repeats >= 2) return { score: 0, pv: [] };
  if (depth <= 0) {
    // Late positions have the checking nets that plain capture search misses.
    // In crowded positions, checking every quiet move at every leaf spends the
    // budget before a useful full-depth iteration can finish.
    const pieces = p.board.reduce((count, piece) => count + Number(piece !== '.'), 0);
    return quiescence(p, alpha, beta, ply, 6, ctx, pieces <= 18 ? 1 : 0);
  }
  // History changes repetition scores. Reuse ordering, never a history-blind score.
  const cacheKey = key,
    cached = ctx.table.get(cacheKey);
  const moves = ordered(p, legalMoves(p), cached?.pv[0]);
  if (moves.length === 0) return { score: -MATE + ply, pv: [] };
  let best = -Infinity,
    pv = [];
  for (const m of moves) {
    const next = negamax(playUnchecked(p, m), depth - 1, -beta, -alpha, ply + 1, ctx, [...path, key]),
      score = -next.score;
    if (score > best) {
      best = score;
      pv = [ucci(m), ...next.pv];
    }
    alpha = Math.max(alpha, score);
    if (alpha >= beta) break;
  }
  const result = { score: best, pv };
  ctx.table.set(cacheKey, { pv });
  return result;
}
function compare(a, b) {
  return (
    Number(b.winsNow) - Number(a.winsNow) ||
    Number(a.losesInOne) - Number(b.losesInOne) ||
    b.score - a.score ||
    a.ucci.localeCompare(b.ucci)
  );
}
export function analyze(p, { maxDepth = 5, timeMs = 3000, historyKeys = [], purpose = 'decision' } = {}) {
  if (
    !Number.isInteger(maxDepth) ||
    maxDepth < 1 ||
    maxDepth > 8 ||
    !Number.isInteger(timeMs) ||
    timeMs < 1 ||
    timeMs > 30000 ||
    !['decision', 'review'].includes(purpose)
  )
    throw new Error('搜索深度 1–8，预算 1–30000 毫秒');
  const start = performance.now(),
    moves = legalMoves(p),
    terminal = outcome(p);
  let candidates = moves
    .map((m) => {
      const audit = auditMove(p, m);
      return {
        ...describe(p, m),
        ...audit,
        score: audit.winsNow ? MATE - 1 : audit.losesInOne ? -MATE + 2 : -evaluate(playUnchecked(p, m)),
        pv: [ucci(m)],
        bestReply: audit.winningReplies[0] ?? null,
        depth: 0,
      };
    })
    .sort(compare);
  const safetyMs = performance.now() - start;
  const ctx = { deadline: performance.now() + timeMs, nodes: 0, table: new Map(), quiescenceLimits: 0 };
  let completedDepth = 0,
    timedOut = false;
  const safe = candidates.some((c) => !c.losesInOne);
  const decisionMode = !moves.length ? 'terminal' : moves.length === 1 && purpose === 'decision' ? 'forced' : purpose;
  if (decisionMode !== 'forced' && decisionMode !== 'terminal' && !candidates.some((c) => c.winsNow)) {
    for (let depth = 1; depth <= maxDepth && candidates.length; depth++) {
      const iteration = [];
      try {
        for (const c of candidates) {
          if (safe && c.losesInOne) {
            iteration.push(c);
            continue;
          }
          const move = moves.find((m) => ucci(m) === c.ucci),
            child = playUnchecked(p, move);
          const result = negamax(child, depth - 1, -Infinity, Infinity, 1, ctx, [...historyKeys, positionKey(p)]);
          const pv = [c.ucci, ...result.pv];
          const reply = result.pv[0]
            ? (() => {
                const replyMove = legalMoves(child).find((m) => ucci(m) === result.pv[0]);
                return replyMove ? describe(child, replyMove) : null;
              })()
            : null;
          iteration.push({ ...c, score: -result.score, pv, bestReply: reply, depth });
        }
        candidates = iteration.sort(compare);
        completedDepth = depth;
      } catch (error) {
        if (error !== TIMEOUT) throw error;
        timedOut = true;
        break;
      }
    }
  }
  return {
    version: 2,
    method: SEARCH_VERSION,
    searchVersion: SEARCH_VERSION,
    decisionMode,
    fen: toFen(p),
    side: p.turn,
    safetyComplete: true,
    safetyMs: Math.round(safetyMs),
    searchBudgetMs: timeMs,
    elapsedMs: Math.round(performance.now() - start),
    completedDepth,
    timedOut,
    nodes: ctx.nodes,
    quiescenceLimits: ctx.quiescenceLimits,
    scoreMeaning: '自建未标定评估，正数利于行棋方；非胜率。深度为完整完成的半回合数。',
    terminal,
    candidates,
  };
}

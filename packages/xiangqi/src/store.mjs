import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { formatMove, parseMove, ucci } from './notation.mjs';
import { applyMove, outcome, parseFen, positionKey, toFen } from './rules.mjs';
import { analyze, auditMove, SEARCH_VERSION } from './search.mjs';

function gamePath(root, id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(id))
    throw new Error('棋局 ID 只能含小写字母、数字、下划线或短横线');
  return join(resolve(root), `${id}.json`);
}
export function durableWrite(path, value, exclusive = false) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (exclusive && existsSync(path)) throw new Error('棋局已存在，不能覆盖');
    renameSync(temporary, path);
    const dir = openSync(resolve(path, '..'), 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function locked(root, id, operation) {
  const path = gamePath(root, id);
  mkdirSync(resolve(root), { recursive: true });
  let fd;
  try {
    fd = openSync(`${path}.lock`, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`棋局正在写入或有未清理的锁：${path}.lock`);
    throw error;
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return operation(path);
  } finally {
    closeSync(fd);
    unlinkSync(`${path}.lock`);
  }
}
function reconstruct(game) {
  let position = parseFen(game.initialFen),
    moves = [];
  for (const event of game.events) {
    if (event.type === 'move') {
      if (outcome(position).status !== 'playing') throw new Error('终局后存在棋步');
      const move = parseMove(position, event.record.ucci);
      position = applyMove(position, move);
      moves.push(event.record);
    } else if (event.type === 'undo') {
      if (!Number.isInteger(event.plies) || event.plies < 1 || event.plies > moves.length)
        throw new Error('无效悔棋记录');
      moves = moves.slice(0, -event.plies);
      position = parseFen(game.initialFen);
      for (const record of moves) position = applyMove(position, parseMove(position, record.ucci));
    } else throw new Error('未知棋谱事件');
  }
  return { position, moves };
}
export function readGame(root, id) {
  const g = JSON.parse(readFileSync(gamePath(root, id), 'utf8'));
  if (g.version !== 1 || g.id !== id || !Array.isArray(g.events) || g.revision !== g.events.length)
    throw new Error('棋谱格式或版本不一致');
  const restored = reconstruct(g);
  if (
    toFen(restored.position) !== g.fen ||
    JSON.stringify(restored.moves) !== JSON.stringify(g.moves) ||
    JSON.stringify(outcome(restored.position)) !== JSON.stringify(g.result)
  )
    throw new Error('棋谱与缓存局面不一致，拒绝继续');
  return g;
}
function snapshot(g) {
  const { position, moves } = reconstruct(g);
  return {
    ...g,
    revision: g.events.length,
    moves,
    fen: toFen(position),
    result: outcome(position),
    updatedAt: new Date().toISOString(),
  };
}
function moveRecord(p, text, actor, extra = {}) {
  const move = parseMove(p, text);
  return {
    ucci: ucci(move),
    notation: formatMove(p, move),
    side: p.turn,
    actor,
    captured: p.board[move.to] === '.' ? null : p.board[move.to],
    ...extra,
  };
}
export function createGame(root, id, { fen, history = [], humanSide = 'red' } = {}) {
  if (!['red', 'black'].includes(humanSide)) throw new Error('无效执棋方');
  return locked(root, id, (path) => {
    if (existsSync(path)) throw new Error('棋局已存在，不能覆盖');
    let p = parseFen(fen);
    const g = {
      version: 1,
      id,
      humanSide,
      initialFen: toFen(p),
      display: { redAtBottom: true, redOneOnLeft: true },
      createdAt: new Date().toISOString(),
      events: [],
    };
    for (const text of history) {
      const record = moveRecord(p, text, 'historical');
      g.events.push({ type: 'move', record, at: g.createdAt });
      p = applyMove(p, parseMove(p, text));
    }
    const saved = snapshot(g);
    durableWrite(path, saved, true);
    return saved;
  });
}
function requireRevision(g, expected) {
  if (!Number.isInteger(expected) || expected !== g.revision)
    throw new Error(`棋局版本冲突：需要 ${g.revision}，收到 ${expected}`);
}
function matchingAnalysis(root, g) {
  const dir = join(resolve(root), `${g.id}-analysis`);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(`r${g.revision}-`) && f.endsWith('.json'))
    .sort()
    .reverse();
  for (const name of files) {
    const file = join(dir, name),
      report = JSON.parse(readFileSync(file, 'utf8'));
    if (
      report.dataRoot === realpathSync(root) &&
      report.gameId === g.id &&
      report.fen === g.fen &&
      report.positionRevision === g.revision &&
      report.searchVersion === SEARCH_VERSION &&
      report.safetyComplete
    )
      return { analysisFile: file, ...report };
  }
  return null;
}
export function readCurrentAnalysis(root, id, expectedRevision) {
  const g = readGame(root, id);
  requireRevision(g, expectedRevision);
  return matchingAnalysis(root, g);
}
export function playGame(root, id, text, { actor, expectedRevision, origin = 'chat' } = {}) {
  if (!['human', 'companion'].includes(actor)) throw new Error('必须标明 human 或 companion');
  if (!['chat', 'board'].includes(origin)) throw new Error('未知落子来源');
  return locked(root, id, (path) => {
    const g = readGame(root, id);
    requireRevision(g, expectedRevision);
    if (g.result.status !== 'playing') throw new Error('本局已结束');
    const p = parseFen(g.fen),
      move = parseMove(p, text);
    if ((p.turn === g.humanSide) !== (actor === 'human')) throw new Error('执棋方与 actor 不一致');
    let audit = null,
      analysisFile = null;
    if (actor === 'companion') {
      const analysis = matchingAnalysis(root, g);
      if (!analysis) throw new Error('请先 analyze 当前局面，再由棋搭子选棋');
      audit = auditMove(p, move);
      analysisFile = analysis.analysisFile;
      if (audit.losesInOne && analysis.candidates.some((c) => !c.losesInOne))
        throw new Error(
          `拦截一步杀漏算：对手可走 ${audit.winningReplies.map((r) => r.notation).join('、')}；存在安全候选`,
        );
    }
    const record = moveRecord(p, text, actor, { audit, analysisFile, origin });
    g.events.push({ type: 'move', record, at: new Date().toISOString() });
    const saved = snapshot(g);
    durableWrite(path, saved);
    return saved;
  });
}
export function undoGame(root, id, plies, expectedRevision) {
  return locked(root, id, (path) => {
    const g = readGame(root, id);
    requireRevision(g, expectedRevision);
    if (!Number.isInteger(plies) || plies < 1 || plies > g.moves.length) throw new Error('悔棋步数无效');
    g.events.push({ type: 'undo', plies, at: new Date().toISOString() });
    const saved = snapshot(g);
    durableWrite(path, saved);
    return saved;
  });
}
export function historyKeys(g) {
  let p = parseFen(g.initialFen);
  const keys = [];
  for (const record of g.moves) {
    keys.push(positionKey(p));
    p = applyMove(p, parseMove(p, record.ucci));
  }
  return keys;
}
export function analyzeGame(root, id, options = {}) {
  const g = readGame(root, id),
    startedAt = new Date().toISOString(),
    report = analyze(parseFen(g.fen), { ...options, historyKeys: historyKeys(g) }),
    after = readGame(root, id);
  if (after.revision !== g.revision || after.fen !== g.fen) throw new Error('分析期间棋盘已变化，丢弃旧结果');
  const dir = join(resolve(root), `${id}-analysis`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `r${g.revision}-${Date.now()}-${randomUUID()}.json`);
  const result = {
    ...report,
    gameId: id,
    dataRoot: realpathSync(root),
    positionRevision: g.revision,
    searchVersion: SEARCH_VERSION,
    source: options.source ?? 'manual',
    queuedAt: options.queuedAt ?? null,
    startedAt,
    createdAt: new Date().toISOString(),
  };
  durableWrite(file, result, true);
  return { ...result, analysisFile: file };
}

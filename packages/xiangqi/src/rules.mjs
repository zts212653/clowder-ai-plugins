export const INITIAL_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1';
export const opposite = (side) => (side === 'red' ? 'black' : 'red');
export const pieceSide = (p) => (p === '.' ? null : p === p.toUpperCase() ? 'red' : 'black');
export const xy = (i) => [i % 9, Math.floor(i / 9)];
const inside = (x, y) => x >= 0 && x < 9 && y >= 0 && y < 10;
const palace = (x, y, s) => x >= 3 && x <= 5 && (s === 'red' ? y >= 7 && y <= 9 : y >= 0 && y <= 2);
const crossed = (y, s) => (s === 'red' ? y <= 4 : y >= 5);
const ORTH = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const HORSES = [
  [1, 2],
  [-1, 2],
  [1, -2],
  [-1, -2],
  [2, 1],
  [2, -1],
  [-2, 1],
  [-2, -1],
];

export function parseFen(fen = INITIAL_FEN) {
  const [placement, turn = 'w', castle = '-', ep = '-', clock = '0', full = '1', extra] = String(fen)
    .trim()
    .split(/\s+/);
  const ranks = placement.split('/');
  if (ranks.length !== 10 || !['w', 'b'].includes(turn) || castle !== '-' || ep !== '-' || extra)
    throw new Error('无效 FEN');
  const board = ranks.flatMap((rank) => {
    if (!/^[rnbakcpRNBAKCP1-9]+$/.test(rank)) throw new Error('无效 FEN 棋子');
    const row = [...rank].flatMap((c) => (/[1-9]/.test(c) ? Array(Number(c)).fill('.') : c));
    if (row.length !== 9) throw new Error('FEN 每行应为九路');
    return row;
  });
  for (const king of ['k', 'K']) {
    if (board.filter((p) => p === king).length !== 1) throw new Error('FEN 必须各有一枚将帅');
    if (!palace(...xy(board.indexOf(king)), pieceSide(king))) throw new Error('将帅须在九宫');
  }
  if (!/^\d+$/.test(clock) || !/^[1-9]\d*$/.test(full) || !Number.isSafeInteger(+clock) || !Number.isSafeInteger(+full))
    throw new Error('无效 FEN 回合数');
  return { board, turn: turn === 'w' ? 'red' : 'black', halfmove: +clock, fullmove: +full };
}
export function toFen(p) {
  const rows = Array.from({ length: 10 }, (_, r) =>
    p.board
      .slice(r * 9, r * 9 + 9)
      .join('')
      .replace(/\.+/g, (s) => String(s.length)),
  );
  return `${rows.join('/')} ${p.turn === 'red' ? 'w' : 'b'} - - ${p.halfmove} ${p.fullmove}`;
}
export const positionKey = (p) => toFen(p).split(' ').slice(0, 2).join(' ');
export function screens(board, from, to) {
  const [x, y] = xy(from),
    [u, v] = xy(to),
    dx = Math.sign(u - x),
    dy = Math.sign(v - y);
  if (from === to || (x !== u && y !== v)) return -1;
  let n = 0;
  for (let a = x + dx, b = y + dy; a !== u || b !== v; a += dx, b += dy) if (board[b * 9 + a] !== '.') n++;
  return n;
}
function attacks(board, from, to) {
  const p = board[from],
    side = pieceSide(p),
    [x, y] = xy(from),
    [u, v] = xy(to);
  const dx = u - x,
    dy = v - y,
    ax = Math.abs(dx),
    ay = Math.abs(dy);
  switch (p.toLowerCase()) {
    case 'r':
      return (dx === 0 || dy === 0) && screens(board, from, to) === 0;
    case 'c':
      return (dx === 0 || dy === 0) && screens(board, from, to) === 1;
    case 'n':
      return ax === 1 && ay === 2
        ? board[(y + dy / 2) * 9 + x] === '.'
        : ax === 2 && ay === 1 && board[y * 9 + x + dx / 2] === '.';
    case 'b':
      return ax === 2 && ay === 2 && !crossed(v, side) && board[(y + dy / 2) * 9 + x + dx / 2] === '.';
    case 'a':
      return ax === 1 && ay === 1 && palace(u, v, side);
    case 'k':
      return (ax + ay === 1 && palace(u, v, side)) || (dx === 0 && screens(board, from, to) === 0);
    case 'p':
      return (dx === 0 && dy === (side === 'red' ? -1 : 1)) || (ay === 0 && ax === 1 && crossed(y, side));
    default:
      return false;
  }
}
export function isCheck(p, side = p.turn) {
  const king = p.board.indexOf(side === 'red' ? 'K' : 'k');
  if (king < 0) return true;
  for (let i = 0; i < 90; i++) if (pieceSide(p.board[i]) === opposite(side) && attacks(p.board, i, king)) return true;
  return false;
}
export function pseudoMoves(p, from) {
  const piece = p.board[from],
    side = pieceSide(piece),
    [x, y] = xy(from),
    type = piece.toLowerCase(),
    out = [];
  const add = (u, v) => {
    if (inside(u, v) && pieceSide(p.board[v * 9 + u]) !== side) out.push({ from, to: v * 9 + u });
  };
  if (!side) return out;
  if (type === 'r' || type === 'c') {
    for (const [dx, dy] of ORTH) {
      let screen = false;
      for (let u = x + dx, v = y + dy; inside(u, v); u += dx, v += dy) {
        const target = p.board[v * 9 + u];
        if (target === '.') {
          if (!screen) add(u, v);
          continue;
        }
        if (type === 'r' || screen) {
          add(u, v);
          break;
        }
        screen = true;
      }
    }
  } else if (type === 'n') {
    for (const [dx, dy] of HORSES) {
      const leg = (Math.abs(dx) === 2 ? y : y + dy / 2) * 9 + (Math.abs(dx) === 2 ? x + dx / 2 : x);
      if (inside(x + dx, y + dy) && p.board[leg] === '.') add(x + dx, y + dy);
    }
  } else if (type === 'b' || type === 'a') {
    const step = type === 'b' ? 2 : 1;
    for (const dx of [-step, step])
      for (const dy of [-step, step]) {
        const u = x + dx,
          v = y + dy;
        if (!inside(u, v)) continue;
        if (type === 'a' ? palace(u, v, side) : !crossed(v, side) && p.board[(y + dy / 2) * 9 + x + dx / 2] === '.')
          add(u, v);
      }
  } else if (type === 'k') {
    for (const [dx, dy] of ORTH) if (palace(x + dx, y + dy, side)) add(x + dx, y + dy);
  } else if (type === 'p') {
    add(x, y + (side === 'red' ? -1 : 1));
    if (crossed(y, side)) {
      add(x - 1, y);
      add(x + 1, y);
    }
  }
  return out;
}
function safeMove(p, m) {
  const piece = p.board[m.from],
    captured = p.board[m.to];
  if (captured.toLowerCase() === 'k') return false;
  p.board[m.from] = '.';
  p.board[m.to] = piece;
  try {
    return !isCheck(p, pieceSide(piece));
  } finally {
    p.board[m.from] = piece;
    p.board[m.to] = captured;
  }
}
export function* legalMoveIterator(p) {
  for (let i = 0; i < 90; i++)
    if (pieceSide(p.board[i]) === p.turn) {
      for (const m of pseudoMoves(p, i)) if (safeMove(p, m)) yield m;
    }
}
export const legalMoves = (p) => [...legalMoveIterator(p)];
export const hasLegalMove = (p) => !legalMoveIterator(p).next().done;
export function outcome(p) {
  if (hasLegalMove(p)) return { status: 'playing' };
  return { status: isCheck(p) ? 'checkmate' : 'stalemate', winner: opposite(p.turn) };
}
export function moveError(p, m) {
  if (
    !m ||
    !Number.isInteger(m.from) ||
    !Number.isInteger(m.to) ||
    m.from < 0 ||
    m.from >= 90 ||
    m.to < 0 ||
    m.to >= 90 ||
    m.from === m.to
  )
    return '无效坐标';
  const piece = p.board[m.from];
  if (pieceSide(piece) !== p.turn) return '不是当前行棋方的棋子';
  if (pieceSide(p.board[m.to]) === p.turn) return '落点是己方棋子';
  const [x, y] = xy(m.from),
    [u, v] = xy(m.to),
    dx = u - x,
    dy = v - y;
  if (piece.toLowerCase() === 'n' && [Math.abs(dx), Math.abs(dy)].sort().join(',') === '1,2') {
    const leg = (Math.abs(dx) === 2 ? y : y + dy / 2) * 9 + (Math.abs(dx) === 2 ? x + dx / 2 : x);
    if (p.board[leg] !== '.') return `蹩马腿：${xy(leg).join(',')} 有棋子`;
  }
  if (!pseudoMoves(p, m.from).some((q) => q.to === m.to)) return '不符合走子规则（路线、炮架、象眼、河界或九宫）';
  if (!safeMove(p, m)) return '此着会使己方将帅受攻，或试图吃将';
  return null;
}
// Internal search primitive. Public callers must use applyMove.
export function playUnchecked(p, m) {
  const board = p.board.slice(),
    piece = board[m.from],
    captured = board[m.to];
  board[m.from] = '.';
  board[m.to] = piece;
  return {
    board,
    turn: opposite(p.turn),
    halfmove: captured !== '.' || piece.toLowerCase() === 'p' ? 0 : p.halfmove + 1,
    fullmove: p.fullmove + (p.turn === 'black' ? 1 : 0),
  };
}
export function applyMove(p, m) {
  const error = moveError(p, m);
  if (error) throw new Error(error);
  return playUnchecked(p, m);
}

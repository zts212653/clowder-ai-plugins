import { moveError, pieceSide, xy } from './rules.mjs';

const DIGITS = '零一二三四五六七八九';
const TYPES = { 车: 'r', 马: 'n', 炮: 'c', 象: 'b', 相: 'b', 士: 'a', 仕: 'a', 将: 'k', 帅: 'k', 兵: 'p', 卒: 'p' };
const NAMES = {
  red: { r: '车', n: '马', c: '炮', b: '相', a: '仕', k: '帅', p: '兵' },
  black: { r: '车', n: '马', c: '炮', b: '象', a: '士', k: '将', p: '卒' },
};
const file = (x, s) => (s === 'red' ? 9 - x : x + 1);
const column = (n, s) => (s === 'red' ? 9 - n : n - 1);
const normalize = (text) =>
  String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(
      /xiang|shuai|jiang|bing|ping|pao|che|shi|jin|tui|ma|ju|zu/g,
      (s) =>
        ({
          xiang: '象',
          shuai: '帅',
          jiang: '将',
          bing: '兵',
          ping: '平',
          pao: '炮',
          che: '车',
          shi: '士',
          jin: '进',
          tui: '退',
          ma: '马',
          ju: '车',
          zu: '卒',
        })[s],
    )
    .replace(/[車馬砲將帥進後]/g, (s) => ({ 車: '车', 馬: '马', 砲: '炮', 將: '将', 帥: '帅', 進: '进', 後: '后' })[s])
    .replace(/[一二三四五六七八九]/g, (s) => String(DIGITS.indexOf(s)))
    .replace(/[\s，,。.!！]/g, '');
const sameFile = (p, from) => {
  const [x] = xy(from),
    piece = p.board[from],
    s = pieceSide(piece);
  return p.board
    .map((q, i) => (q === piece && i % 9 === x ? i : -1))
    .filter((i) => i >= 0)
    .sort((a, b) => (s === 'red' ? a - b : b - a));
};
export function ucci(m) {
  const square = (i) => `${String.fromCharCode(97 + (i % 9))}${9 - Math.floor(i / 9)}`;
  return square(m.from) + square(m.to);
}
export function formatMove(p, m) {
  const s = pieceSide(p.board[m.from]),
    type = p.board[m.from].toLowerCase(),
    [x, y] = xy(m.from),
    [u, v] = xy(m.to);
  const n = (k) => (s === 'red' ? DIGITS[k] : String(k)),
    peers = sameFile(p, m.from),
    name = NAMES[s][type];
  let prefix = name + n(file(x, s));
  if (peers.length > 1) {
    if (peers.length > 3) return ucci(m); // Avoid ambiguous multi-pawn tournament abbreviations.
    const anotherStack = p.board.some((q, i) => q === p.board[m.from] && i % 9 !== x && sameFile(p, i).length > 1);
    if (anotherStack) return ucci(m);
    const labels = peers.length === 2 ? ['前', '后'] : ['前', '中', '后'];
    prefix = labels[peers.indexOf(m.from)] + name;
  }
  const op = y === v ? '平' : (v - y) * (s === 'red' ? -1 : 1) > 0 ? '进' : '退';
  const end = op === '平' || ['n', 'b', 'a'].includes(type) ? file(u, s) : Math.abs(v - y);
  return prefix + op + n(end);
}
export function parseMove(p, text) {
  const raw = normalize(text);
  let move;
  if (/^[a-i][0-9][a-i][0-9]$/.test(raw)) {
    move = {
      from: (9 - Number(raw[1])) * 9 + raw.charCodeAt(0) - 97,
      to: (9 - Number(raw[3])) * 9 + raw.charCodeAt(2) - 97,
    };
  } else {
    const match = /^([车马炮象相士仕将帅兵卒])([1-9])([进退平])([1-9])$/.exec(raw);
    const front = /^([前中后])([车马炮象相士仕将帅兵卒])([进退平])([1-9])$/.exec(raw);
    if (!match && !front) throw new Error('棋步格式：炮八平五、ma 8 jin 7 或 b2e2');
    const type = TYPES[match ? match[1] : front[2]],
      op = (match || front)[3],
      end = Number((match || front)[4]);
    let sources = p.board
      .map((q, i) => (pieceSide(q) === p.turn && q.toLowerCase() === type ? i : -1))
      .filter((i) => i >= 0);
    if (match) sources = sources.filter((i) => file(i % 9, p.turn) === Number(match[2]));
    else
      sources = sources.filter((i) => {
        const peers = sameFile(p, i),
          index = peers.indexOf(i);
        return (
          peers.length > 1 &&
          (front[1] === '前'
            ? index === 0
            : front[1] === '后'
              ? index === peers.length - 1
              : peers.length === 3 && index === 1)
        );
      });
    if (sources.length !== 1)
      throw new Error(sources.length ? '棋步有歧义，请用前/后或 UCCI 坐标' : '这一路没有该棋子');
    const from = sources[0],
      [x, y] = xy(from),
      direction = (p.turn === 'red' ? -1 : 1) * (op === '进' ? 1 : -1);
    let u = x,
      v = y;
    if (op === '平') u = column(end, p.turn);
    else if (['n', 'b', 'a'].includes(type)) {
      u = column(end, p.turn);
      const dx = Math.abs(u - x);
      v += direction * (type === 'n' ? (dx === 1 ? 2 : dx === 2 ? 1 : 99) : type === 'b' ? 2 : 1);
    } else v += direction * end;
    if (u < 0 || u > 8 || v < 0 || v > 9) throw new Error('落点超出棋盘');
    move = { from, to: v * 9 + u };
  }
  const error = moveError(p, move);
  if (error) throw new Error(error);
  return move;
}

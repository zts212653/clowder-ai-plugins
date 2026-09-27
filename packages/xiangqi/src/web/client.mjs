const $ = (id) => document.getElementById(id);
const glyph = {
  r: '車',
  n: '馬',
  b: '象',
  a: '士',
  k: '將',
  c: '砲',
  p: '卒',
  R: '车',
  N: '马',
  B: '相',
  A: '仕',
  K: '帅',
  C: '炮',
  P: '兵',
};
let state = null,
  selected = null,
  draft = null,
  restartRevision = null,
  busy = false,
  mirrored = localStorage.getItem('xiangqi-mirror') !== 'false';
const svgNS = 'http://www.w3.org/2000/svg';
function svg(tag, attributes) {
  const el = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attributes)) el.setAttribute(k, v);
  return el;
}
const x = (c) => 30 + c * 60,
  y = (r) => 30 + r * 60;
function grid() {
  const lines = $('lines');
  lines.replaceChildren();
  const line = (a, b, c, d) =>
    lines.append(svg('line', { x1: a, y1: b, x2: c, y2: d, stroke: '#91764d', 'stroke-width': 1.2 }));
  for (let r = 0; r < 10; r++) line(x(0), y(r), x(8), y(r));
  for (let c = 0; c < 9; c++) {
    line(x(c), y(0), x(c), y(4));
    line(x(c), y(5), x(c), y(9));
  }
  line(x(0), y(4), x(0), y(5));
  line(x(8), y(4), x(8), y(5));
  for (const r of [0, 7]) {
    line(x(3), y(r), x(5), y(r + 2));
    line(x(5), y(r), x(3), y(r + 2));
  }
  for (const [c, text] of [
    [1.7, '楚 河'],
    [6.3, '漢 界'],
  ]) {
    const t = svg('text', {
      x: x(c),
      y: 311,
      'text-anchor': 'middle',
      fill: '#8e754e',
      'font-family': 'Kaiti SC, STKaiti, serif',
      'font-size': 30,
    });
    t.textContent = text;
    lines.append(t);
  }
}
function indices(move) {
  if (!move) return [];
  return [(9 - Number(move[1])) * 9 + move.charCodeAt(0) - 97, (9 - Number(move[3])) * 9 + move.charCodeAt(2) - 97];
}
const draftKey = () => `xiangqi-draft:${state.id}`;
function setDraft(move) {
  draft = move ? { ...move, revision: state.revision } : null;
  if (draft) localStorage.setItem(draftKey(), JSON.stringify(draft));
  else localStorage.removeItem(draftKey());
}
function restoreDraft() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(draftKey()));
  } catch {
    saved = null;
  }
  const move = saved?.revision === state.revision ? state.legalMoves.find((m) => m.ucci === saved.ucci) : null;
  setDraft(move);
  if (move) selected = move.from;
}
function renderBoard() {
  const board = $('squares'),
    last = indices(state.lastMove),
    canPlay = state.turn === state.humanSide && state.result.status === 'playing' && !busy;
  const displayBoard = [...state.board];
  if (draft) {
    displayBoard[draft.to] = displayBoard[draft.from];
    displayBoard[draft.from] = '.';
  }
  board.replaceChildren();
  for (const [id, red] of [
    ['black-files', false],
    ['red-files', true],
  ]) {
    $(id).replaceChildren(
      ...Array.from({ length: 9 }, (_, i) => {
        const n = document.createElement('span');
        const v = mirrored ? i + 1 : 9 - i;
        n.textContent = red ? '一二三四五六七八九'[v - 1] : String(10 - v);
        return n;
      }),
    );
  }
  for (let r = 0; r < 10; r++)
    for (let screen = 0; screen < 9; screen++) {
      const c = mirrored ? 8 - screen : screen,
        index = r * 9 + c,
        piece = displayBoard[index],
        red = piece !== '.' && piece === piece.toUpperCase();
      const move = state.legalMoves.find((m) => m.from === selected && m.to === index),
        button = document.createElement('button');
      button.type = 'button';
      button.dataset.index = String(index);
      button.className = 'square';
      button.setAttribute(
        'aria-label',
        piece === '.' ? `空点 ${index}` : `${red ? '红' : '黑'}${red ? 9 - c : c + 1}路${glyph[piece]}，第${r + 1}横线`,
      );
      if (last.includes(index)) button.classList.add('last');
      if (draft?.from === index) button.classList.add('draft-from');
      if (draft?.to === index) button.classList.add('draft-to');
      if (index === selected) button.classList.add('selected');
      if (canPlay && move && draft?.to !== index) button.classList.add('legal');
      if (canPlay && red) button.classList.add('can-select');
      button.disabled = !canPlay;
      if (piece !== '.') {
        const stone = document.createElement('span');
        stone.className = `piece ${red ? 'red' : 'black'}`;
        stone.textContent = glyph[piece];
        button.append(stone);
      }
      button.addEventListener('click', () => choose(index));
      board.append(button);
    }
}
function render() {
  if (!state) return;
  renderBoard();
  const over = state.result.status !== 'playing',
    human = state.turn === state.humanSide,
    humanName = state.players.human,
    companionName = state.players.companion;
  $('heading-human').textContent = humanName;
  $('heading-companion').textContent = companionName;
  const humanRed = state.humanSide === 'red';
  $('north-name').textContent = humanRed ? companionName : humanName;
  $('south-name').textContent = humanRed ? humanName : companionName;
  $('north-detail').textContent = humanRed ? '执黑 · 亲自应招' : '执黑 · 后手';
  $('south-detail').textContent = '执红 · 先行';
  $('red-label').textContent = `${humanRed ? humanName : companionName} · 红`;
  $('black-label').textContent = `${humanRed ? companionName : humanName} · 黑`;
  $('retry').textContent = `重试通知${companionName}`;
  $('turn').textContent = over
    ? `${state.result.winner === state.humanSide ? humanName : companionName}胜 · ${state.result.status === 'checkmate' ? '将死' : '困毙'}`
    : human
      ? state.inCheck
        ? `${humanName}请应将`
        : `轮到${humanName}`
      : `等${companionName}应招`;
  $('hint').textContent = over
    ? '这一盘收官了。可以悔一回合，或重新开局。'
    : busy
      ? '正在保存这一手…'
      : draft
        ? `这手只是预选。确认后才保存棋步、通知${companionName}。`
        : selected !== null
          ? '点亮起的落点预览，再点“确认落子并发送”。'
          : human
            ? '点自己的棋子、点落点，最后确认发送。'
            : `棋已保存，${companionName}的应招会直接落回棋盘。`;
  const d = state.delivery;
  $('delivery').textContent =
    d.status === 'error'
      ? '棋已保存，通知暂未送达。可点下方重试。'
      : d.status === 'accepted'
        ? `已通知${companionName}。`
        : d.status === 'pending'
          ? `正在通知${companionName}…`
          : '';
  $('retry').hidden = d.status !== 'error';
  $('retry').disabled = busy;
  $('undo').disabled = busy || !state.history.length;
  $('undo').textContent = human ? '悔一回合' : '撤回这一步';
  $('draft-label').textContent = draft ? `预选：${draft.notation} · 尚未发送` : '选好落点后，再确认发送。';
  $('confirm-move').disabled = busy || !draft;
  $('cancel-move').disabled = busy || (selected === null && !draft);
  $('restart').disabled = busy;
  $('restart-panel').hidden = restartRevision === null;
  $('confirm-restart').disabled = busy;
  $('cancel-restart').disabled = busy;
  $('round').textContent = state.history.length ? `${Math.ceil(state.history.length / 2)} 回合` : '尚未落子';
  $('empty-history').hidden = state.history.length > 0;
  const list = $('history');
  list.replaceChildren();
  for (let i = 0; i < state.history.length; i += 2) {
    const row = document.createElement('li');
    for (const text of [
      String(i / 2 + 1).padStart(2, '0'),
      state.history[i].notation,
      state.history[i + 1]?.notation ?? '…',
    ]) {
      const span = document.createElement('span');
      span.textContent = text;
      row.append(span);
    }
    list.append(row);
  }
  list.scrollTop = list.scrollHeight;
}
async function refresh() {
  if (busy) return;
  try {
    const response = await fetch('./api/state', { cache: 'no-store' });
    if (!response.ok) throw Error('暂时连不上棋桌');
    const next = await response.json();
    if (busy) return;
    if (state && next.revision < state.revision) return;
    const changed =
      !state ||
      state.revision !== next.revision ||
      state.token !== next.token ||
      state.delivery.status !== next.delivery.status;
    const newPosition = state?.revision !== next.revision;
    if (newPosition) {
      selected = null;
      restartRevision = null;
    }
    state = next;
    if (newPosition) restoreDraft();
    if (changed) render();
    $('connection').textContent = '棋局已保存 · 本机连接';
  } catch (error) {
    $('connection').textContent = '连接中断 · 棋局仍保留';
    $('hint').textContent = error.message;
  }
}
async function action(path, body) {
  if (busy || !state) return;
  busy = true;
  render();
  try {
    const response = await fetch(`./api/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chess-token': state.token },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error);
    state = result;
    selected = null;
    setDraft(null);
    restartRevision = null;
  } catch (error) {
    $('hint').textContent = error.message;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  } finally {
    busy = false;
    render();
    await refresh();
  }
}
function choose(index) {
  if (!state || busy) return;
  restartRevision = null;
  const move = state.legalMoves.find((m) => m.from === selected && m.to === index);
  if (move) {
    setDraft(move);
    render();
    return;
  }
  setDraft(null);
  selected = selected === index ? null : state.legalMoves.some((m) => m.from === index) ? index : null;
  render();
}
$('flip').addEventListener('click', () => {
  mirrored = !mirrored;
  localStorage.setItem('xiangqi-mirror', String(mirrored));
  render();
});
$('undo').addEventListener('click', () => void action('undo', { revision: state.revision }));
$('retry').addEventListener('click', () => void action('retry', { revision: state.revision }));
$('confirm-move').addEventListener('click', () => {
  if (draft && draft.revision === state.revision)
    void action('move', { move: draft.ucci, revision: draft.revision, confirmed: true });
});
function cancelDraft() {
  if (busy || !state) return;
  selected = null;
  setDraft(null);
  render();
}
$('cancel-move').addEventListener('click', cancelDraft);
$('restart').addEventListener('click', () => {
  restartRevision = state.revision;
  render();
});
$('cancel-restart').addEventListener('click', () => {
  restartRevision = null;
  render();
});
$('confirm-restart').addEventListener('click', () => {
  if (restartRevision !== null) void action('restart', { revision: restartRevision, confirmed: true });
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    restartRevision = null;
    cancelDraft();
  }
});
grid();
await refresh();
setInterval(() => {
  if (!document.hidden) void refresh();
}, 1000);

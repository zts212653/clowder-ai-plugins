import { esc, shortSha } from './ui.mjs';

const labels = { all: '全部', complete: '已完成', current: '同步中', pending: '未同步', cancelled: '已撤销' };
export function roundView(round, error = '') {
  if (error)
    return `<p class="bad" role="alert">本轮清单未能更新：${esc(error)}，原同步继续。</p><button type="button" data-round-reload>重新读取本轮清单</button>`;
  if (!round) return '<p role="status">正在读取本轮目标与逐笔进展…</p>';
  const c = round.counts,
    kind = { commit: 'commit', tag: 'tag', latest: '最新分支', queue: '已冻结清单' }[round.selection?.kind];
  return `<div class="round-heading"><h2>本轮同步进度 <span>${c.complete} / ${round.total ?? '待确定'} 笔已完成</span></h2><p class="note-line" data-round-current>${round.current ? `当前：${esc(sourceTitle(round.current))}` : round.status === 'COMPLETE' ? '本轮已全部接收' : '当前没有正在同步的交付'}</p></div><div class="round-target">目标 ${esc(kind)} · ${shortSha(round.selection?.value ?? round.target ?? '来源扫描后确定')}<span>同步中 ${c.current} · 未同步 ${c.pending} · 已撤销 ${c.cancelled}</span></div><div class="round-filter" role="group" aria-label="本轮进度筛选">${Object.entries(
    labels,
  )
    .map(
      ([key, name]) =>
        `<button type="button" data-round-filter="${key}" aria-pressed="${(round.filter ?? 'all') === key}">${name}${key === 'all' ? '' : ` ${c[key]}`}</button>`,
    )
    .join(
      '',
    )}</div><ol class="round-items">${round.items.map(rowView).join('') || '<li>本轮来源清单尚在读取，或没有符合筛选的交付。</li>'}</ol><div class="round-pages"><small>显示 ${round.items.length ? round.offset + 1 : 0}–${round.offset + round.items.length} / ${round.matched} 笔 · 创建 PR 不计完成</small>${round.matched > 20 ? `<button type="button" data-round-page="-1" ${round.offset ? '' : 'disabled'}>上一页</button><button type="button" data-round-page="1" ${round.offset + round.items.length < round.matched ? '' : 'disabled'}>下一页</button>` : ''}</div>`;
}
function sourceTitle(row) {
  const s = row.source;
  return `${s.number ? `上游 PR #${s.number}` : s.tag ? `tag ${s.tag}` : `无 PR 主干提交 ${row.target.slice(0, 12)}`} · ${s.title ?? ''}`;
}
function link(url, label) {
  return /^https?:\/\//.test(url ?? '')
    ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)} ↗</a>`
    : esc(label);
}
function rowView(row) {
  return `<li data-round-target="${esc(row.target)}" data-round-status="${row.status}"><div><b>${link(row.source.url, sourceTitle(row))}</b><small>外部 ${shortSha(row.target)}${row.internal ? ` → 内部 ${shortSha(row.internal)}` : ''} · Issue ${row.issueCount} · 提交 ${row.commitCount ?? '待核对'}</small></div><span>${labels[row.status]}${row.lastAttempt ? ' · 等待重新同步' : ''}</span>${row.deliveryId ? `<button type="button" data-record="${esc(row.deliveryId)}">${row.status === 'current' ? '查看当前流程' : '查看同步记录'}</button>` : '<span>按顺序接收</span>'}${row.prUrl ? link(row.prUrl, '内部 PR') : ''}</li>`;
}

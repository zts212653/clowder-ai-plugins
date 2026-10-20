import { pageProjectId, projectUrl } from './project-scope.mjs';
import { boundaryDeliveryId } from './flow-stage.mjs';
import { esc, labels, title, when } from './ui.mjs';

export function createHistory(snapshot, changed) {
  let selected = new URL(location.href).searchParams.get('record') ?? 'current';
  let page = { records: [], total: 0, offset: 0, limit: 20 };
  let detail = null;
  let error = null;
  let generation = 0;
  let filters = { q: '', status: 'all', from: '', to: '' };
  let binding;
  const cache = new Map();
  function storageKey() {
    return `repo-sync-navigation:${pageProjectId === 'default' ? '' : `${pageProjectId}:`}${snapshot().config?.bindingId ?? 'setup'}`;
  }
  async function request(path) {
    const response = await fetch(projectUrl(path), {
      headers: { 'X-Repo-Sync-Token': snapshot().token },
      signal: AbortSignal.timeout(8000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`${result.code}：${result.message}`);
    return result;
  }
  function save() {
    try {
      sessionStorage.setItem(storageKey(), JSON.stringify({ filters, offset: page.offset }));
    } catch {}
    const url = new URL(location.href);
    if (selected === 'current') url.searchParams.delete('record');
    else url.searchParams.set('record', selected);
    history.replaceState(null, '', url);
  }
  function restoreBinding(nextBinding) {
    if (binding !== nextBinding) {
      binding = nextBinding;
      cache.clear();
      try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey()));
        if (saved) {
          filters = saved.filters;
          page.offset = saved.offset;
        }
      } catch {}
    }
  }
  function acceptPage(id, nextPage, nextDetail) {
    page = nextPage;
    detail = nextDetail;
    if (id && detail && !detail.current) {
      cache.set(id, detail);
      if (cache.size > 12) cache.delete(cache.keys().next().value);
    }
  }
  function selectedId(chosen, invalidate) {
    const pending = snapshot().operation?.persistence?.status === 'FAILED';
    const id =
      chosen === 'current'
        ? (snapshot().state.active?.id ??
          (pending ? snapshot().operation.deliveryId : boundaryDeliveryId(snapshot().state)))
        : chosen;
    if (invalidate && (id === snapshot().state.active?.id || pending)) cache.delete(id);
    return id;
  }
  function readDetail(id) {
    return id ? (cache.get(id) ?? request(`/api/records/${id}`)) : null;
  }
  async function load(invalidate = false) {
    const currentBinding = snapshot().config?.bindingId;
    if (!currentBinding || !snapshot().state) return;
    restoreBinding(currentBinding);
    const ticket = ++generation;
    const chosen = selected;
    const id = selectedId(chosen, invalidate);
    const params = new URLSearchParams({
      ...Object.fromEntries(Object.entries(filters).filter(([, value]) => value)),
      offset: String(page.offset),
      limit: '20',
    });
    try {
      const [nextPage, nextDetail] = await Promise.all([request(`/api/records?${params}`), readDetail(id)]);
      if (ticket !== generation || chosen !== selected) return;
      acceptPage(id, nextPage, nextDetail);
      error = null;
    } catch (failure) {
      if (ticket === generation) {
        error = failure.message;
        detail = null;
      }
    }
  }
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-history-range]');
    if (!button) return;
    filters = {
      ...filters,
      ...Object.fromEntries(new FormData(button.closest('form'))),
      ...historyDateRange(button.dataset.historyRange),
    };
    page.offset = 0;
    save();
    await load();
    changed();
  });
  return {
    load,
    get: () => ({ selected, page, detail, error, filters }),
    async select(id) {
      selected = id;
      detail = null;
      save();
      await load();
      changed();
    },
    async filter(values) {
      filters = values;
      page.offset = 0;
      save();
      await load();
      changed();
    },
    async move(offset) {
      page.offset = offset;
      save();
      await load();
      changed();
    },
    async moreTasks() {
      if (!detail?.taskPage.hasMore) return;
      const id = detail.delivery.id;
      const result = await request(`/api/records/${id}?taskOffset=${detail.taskPage.offset + 50}`);
      if (detail?.delivery.id !== id) return;
      detail.tasks.unshift(...result.tasks);
      detail.missingTasks.push(...result.missingTasks);
      detail.taskPage = result.taskPage;
      changed();
    },
  };
}
export function recordList(view, active) {
  const { page, selected, filters } = view;
  const filtered = filters.q || filters.status !== 'all' || filters.from || filters.to;
  const empty = filtered
    ? '没有符合筛选条件的记录。可调整关键词、状态，或清除日期范围。'
    : '尚无同步记录。首次同步后，可在这里回看每笔版本、PR、步骤和时间。';
  const range = page.records.length ? ` · 当前显示 ${page.offset + 1}–${page.offset + page.records.length}` : '';
  const dates = `<div class="history-date-shortcuts" aria-label="历史日期快捷筛选">${[7, 30, 90].map((days) => `<button type="button" data-history-range="${days}">最近 ${days} 天</button>`).join('')}<button type="button" data-history-range="all">不限日期</button></div><small>日期按记录的 UTC 日历日筛选；不改变关键词和状态。</small>`;
  const row = (item) =>
    `<button type="button" data-record="${esc(item.id)}" aria-current="${selected === item.id ? 'true' : 'false'}"><b>${esc(title(item))}</b><span class="${item.error ? 'bad' : item.status === 'COMPLETE' ? 'good' : ''}">${item.error ? '× 异常 · ' : ''}${esc(labels[item.status] ?? item.status)}</span>${item.syncTarget ? `<small>本轮终点 ${esc(item.syncTarget.value)}</small>` : ''}<small>${when(item.finishedAt ?? item.startedAt)}</small></button>`;
  return `<aside class="record-list" aria-label="同步记录"><h2>同步记录</h2><button type="button" data-record="current" aria-current="${selected === 'current'}"><b>当前同步</b><small>${active ? `${esc(title(active))} · ${esc(labels[active.status])}` : '选择更新 / 查看最新接收状态'}</small></button><form data-record-filter><label>搜索记录<input name="q" maxlength="200" value="${esc(filters.q)}" placeholder="tag、PR、commit 或同步标识"></label><label>状态<select name="status">${[
    ['all', '全部'],
    ['complete', '已完成'],
    ['active', '未完成'],
    ['failed', '异常'],
    ['cancelled', '已撤销'],
  ]
    .map(([value, label]) => `<option value="${value}" ${filters.status === value ? 'selected' : ''}>${label}</option>`)
    .join(
      '',
    )}</select></label>${dates}<details><summary>自选日期范围</summary><label>开始日期<input name="from" type="date" value="${esc(filters.from)}"></label><label>结束日期<input name="to" type="date" value="${esc(filters.to)}"></label></details><button type="submit">筛选记录</button></form><p>${page.total} 笔匹配记录${range}</p>${page.records.map(row).join('') || `<p role="status">${empty}</p>`}<div class="file-pages"><button type="button" data-record-page="${Math.max(0, page.offset - 20)}" ${page.offset ? '' : 'disabled'}>上一页</button><button type="button" data-record-page="${page.offset + 20}" ${page.offset + page.records.length < page.total ? '' : 'disabled'}>下一页</button></div></aside>`;
}

export function historyDateRange(days, now = new Date()) {
  if (days === 'all') return { from: '', to: '' };
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - Number(days) + 1);
  return { from: start.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
}

import { pageProjectId, projectUrl } from './project-scope.mjs';
import { roundView } from './round-view.mjs';
import { esc } from './ui.mjs';
export function createRoundView(snapshot) {
  let data = null,
    error = '',
    offset = 0,
    filter = 'all',
    generation = 0;
  function paint() {
    const target = document.querySelector('[data-round-slot]');
    if (!target) return;
    const listScroll = target.querySelector('.round-items')?.scrollTop ?? 0;
    const active = document.activeElement;
    const key = ['roundFilter', 'roundPage', 'roundReload'].find(
      (key) => active?.dataset?.[key] !== undefined,
    );
    const value = key && active.dataset[key];
    target.innerHTML = roundView(data, error);
    const list = target.querySelector('.round-items');
    if (list) list.scrollTop = listScroll;
    if (key)
      [...target.querySelectorAll('button')]
        .find((e) => e.dataset[key] === value)
        ?.focus({ preventScroll: true });
  }
  async function load() {
    const current = snapshot(),
      runId = current.state?.automation?.id,
      binding = current.config?.bindingId;
    if (!runId) {
      ++generation;
      data = null;
      error = '';
      return;
    }
    if (data?.runId !== runId) {
      offset = 0;
      filter = 'all';
    }
    const ticket = ++generation;
    try {
      const response = await fetch(projectUrl(`/api/round?offset=${offset}&limit=20&status=${filter}`), {
        signal: AbortSignal.timeout(8000),
        headers: { 'X-Repo-Sync-Token': current.token },
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.message ?? '本轮清单读取失败');
      if (
        ticket !== generation ||
        snapshot().state?.automation?.id !== runId ||
        snapshot().config?.bindingId !== binding
      )
        return;
      if (result.round?.runId !== runId) throw Error('轮次已变化，请重新读取；未显示另一轮清单');
      data = { ...result.round, filter };
      error = '';
    } catch (e) {
      if (
        ticket !== generation ||
        snapshot().state?.automation?.id !== runId ||
        snapshot().config?.bindingId !== binding
      )
        return;
      error = e.message;
    }
    paint();
  }
  document.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-round-filter], [data-round-page], [data-round-reload]');
    if (!button) return;
    if (button.dataset.roundFilter) {
      filter = button.dataset.roundFilter;
      offset = 0;
    }
    if (button.dataset.roundPage) offset = Math.max(0, offset + Number(button.dataset.roundPage) * 20);
    await load();
  });
  return {
    load,
    render: () =>
      snapshot().state?.automation
        ? `<section data-round-slot data-project="${esc(pageProjectId)}" aria-label="本轮同步进度">${roundView(data?.runId === snapshot().state.automation.id ? data : null, error)}</section>`
        : '',
  };
}

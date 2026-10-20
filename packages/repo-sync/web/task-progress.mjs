const names = {
  'Receiving objects': '接收对象',
  'Resolving deltas': '解析增量',
  'Counting objects': '统计对象',
  'Compressing objects': '压缩对象',
};
export function taskProgress(step, esc, now = Date.now(), detailed = true) {
  const progress = step.progress;
  const running = step.status === 'RUNNING';
  const elapsed = Math.max(0, Math.floor((now - Date.parse(step.startedAt)) / 1000));
  const age = progress ? (now - Date.parse(progress.observedAt)) / 1000 : NaN;
  const stale = running && (!Number.isFinite(age) || age > 30);
  const signal = progress
    ? `<small>${stale ? '最近报告：' : ''}${esc(names[progress.phase] ?? progress.phase)} ${esc(progress.percent)}% · ${esc(progress.completed)}/${esc(progress.total)}${detailed ? (progress.observedAt ? ` · ${esc(progress.observedAt)}` : ' · 报告时间未知') : ''}</small>`
    : '';
  const quiet =
    stale && Number.isFinite(age) ? '<small>超过 30 秒没有新的 Git 进度；仍在查询原任务。</small>' : '';
  const long =
    detailed && running && elapsed > 300
      ? '<small>耗时较长，仍在观察原进程。可以取消可取消的下载，确认退出后再恢复。</small>'
      : '';
  return `${signal}${quiet}${long}`;
}

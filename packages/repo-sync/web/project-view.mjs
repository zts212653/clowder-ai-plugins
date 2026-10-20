import { esc, when } from './ui.mjs';

const modes = { continuous: '同步开发过程', version: '按 tag 更新' };
const statuses = {
  UNCONFIGURED: '待配置仓库',
  BASELINE_REQUIRED: '待核验同步起点',
  RUNNING: '自动执行中',
  WAITING_REVIEW: '等待审核合入',
  FAILED: '异常待处理',
  OBSERVATION_FAILED: '合入状态读取失败',
  PAUSED: '已停止后续处理',
  ACTION_REQUIRED: '原同步需要处理',
  READY: '可选择下次目标',
  COMPLETE: '本轮已完成',
};
const attention = new Set([
  'UNCONFIGURED',
  'BASELINE_REQUIRED',
  'WAITING_REVIEW',
  'FAILED',
  'OBSERVATION_FAILED',
  'PAUSED',
  'ACTION_REQUIRED',
]);

export function projectView(
  { workspace, editor, pendingCreate, sending, error, filter = 'all', overviewOpen = false, navigation },
  selected,
) {
  if (!workspace) return `<p class="bad" role="alert">${esc(error)}</p>`;
  const current = workspace.projects.find((project) => project.id === selected);
  const options = workspace.projects.map((project) => projectOption(project, selected)).join('');
  const unknown = current ? '' : '<option value="" selected disabled>项目不存在，请重新选择</option>';
  const sidebar = `<nav class="project-sidebar-list" aria-label="项目侧栏">${workspace.projects.map((project) => `<div class="project-sidebar-row ${project.id === selected ? 'selected' : ''}"><button type="button" data-project-enter="${esc(project.id)}"><b title="${esc(project.name)}">${esc(project.name)}</b><small>${esc(modes[project.mode] ?? '待配置')} · ${esc(statuses[project.syncStatus] ?? '状态未读取')}</small></button><button type="button" data-project-settings="${esc(project.id)}" aria-label="${esc(project.name)}的仓库设置" title="仓库设置">⚙</button></div>`).join('')}</nav>`;
  return `${sidebar}<div class="project-controls"><label hidden>当前同步项目<select data-project-select>${unknown}${options}</select></label><button type="button" data-project-create>＋ 新增项目</button></div><p>每个项目独立保存仓库、模式、同步历史与任务。普通草稿按项目保存，未提交的 Token 不保存；切换不停止后台同步。</p>${navigation ? `<div class="project-switch-warning" role="alert"><p>${esc(navigation.message)}</p><div class="task-actions"><button type="button" data-project-stay>留在当前项目</button><button type="button" data-project-leave>放弃未保存内容后切换</button></div></div>` : ''}${overview(workspace.projects, selected, filter, overviewOpen)}${editor ? editorForm(editor, current, pendingCreate, sending) : ''}${error ? `<p class="bad" role="alert">${esc(error)}</p>${pendingCreate ? '<button type="button" data-project-retry>查询 / 重试原新增请求</button>' : ''}` : ''}`;
}
function projectOption(project, selected) {
  const mode = modes[project.mode] ?? '待配置';
  const label = project.error ? '配置异常' : mode;
  return `<option value="${esc(project.id)}" ${project.id === selected ? 'selected' : ''}>${esc(project.name)} · ${label}${project.syncStatus ? ` · ${statuses[project.syncStatus] ?? '状态未知'}` : project.busy ? ' · 任务处理中' : ''}</option>`;
}
function overview(projects, selected, filter, open) {
  const visible = projects.filter((project) =>
    filter === 'attention'
      ? project.error || attention.has(project.syncStatus)
      : filter === 'running'
        ? project.busy || project.syncStatus === 'RUNNING'
        : true,
  );
  const filters = [
    ['all', '全部'],
    ['attention', '需要处理'],
    ['running', '运行中'],
  ]
    .map(
      ([value, label]) =>
        `<button type="button" data-project-filter="${value}" aria-pressed="${value === filter}">${label}</button>`,
    )
    .join('');
  return `<details class="project-overview" data-project-overview ${open ? 'open' : ''}><summary>查看项目状态 · ${projects.length} 个项目</summary><div class="project-filters" aria-label="项目状态筛选">${filters}</div><p>仅展示本地台账与最近观测，不自动检查所有远端。</p><div class="project-cards">${visible.map((project) => projectCard(project, selected)).join('') || '<p role="status">没有符合当前状态的项目。可选择“全部”查看。</p>'}</div></details>`;
}
function projectCard(project, selected) {
  const status = project.error ? '配置异常' : (statuses[project.syncStatus] ?? '状态尚未读取');
  const accepted = project.accepted?.tag ?? project.accepted?.upstream ?? '尚未登记';
  return `<article class="project-card"><h3>${esc(project.name)}${project.id === selected ? ' · 当前项目' : ''}</h3><p>${esc(modes[project.mode] ?? '待选择同步模式')} · <b>${status}</b></p><dl><dt>最后接收</dt><dd>${esc(accepted)}</dd><dt>接收时间</dt><dd>${when(project.lastAcceptedAt)}</dd><dt>最后扫描</dt><dd>${when(project.lastScannedAt)}</dd><dt>最后观察</dt><dd>${when(project.lastObservedAt)}</dd></dl>${project.observationError || project.error ? `<p class="bad">${esc(project.error?.code ?? project.observationError.code)} · 进入项目查看原记录与处理方式</p>` : ''}<button type="button" data-project-enter="${esc(project.id)}">${project.error || attention.has(project.syncStatus) ? '进入项目，查看下一步' : '进入项目'}</button></article>`;
}
function editorForm(editor, current, pendingCreate, sending) {
  const name = editor === 'rename' ? (current?.name ?? '') : (pendingCreate?.name ?? '');
  return `<form data-project-form><label>项目名称<input name="name" required maxlength="80" value="${esc(name)}" placeholder="例如：通用核心 / 定制产品"></label><div class="task-actions"><button type="submit" class="primary" ${sending ? 'disabled' : ''}>${editor === 'create' ? '创建项目，配置仓库 →' : '保存项目名称'}</button><button type="button" data-project-cancel>取消</button></div></form>`;
}

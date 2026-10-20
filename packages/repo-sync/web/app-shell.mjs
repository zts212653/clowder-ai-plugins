export function updateShell(snapshot, view) {
  const id = snapshot.workspace?.currentId;
  const name = snapshot.workspace?.projects?.find((project) => project.id === id)?.name ?? '当前项目';
  const shell = {
    workbench: ['同步工作台', '查看本笔进展，在当前操作区完成下一步。'],
    records: ['同步记录', '回看每一笔的版本、PR、五阶段过程与结果。'],
    configuration: ['仓库设置', '仓库、认证与接收策略。可编辑项统一保存，当前同步进度保留。'],
  }[view] ?? ['同步工作台', '查看本笔进展，在当前操作区完成下一步。'];
  document.body.dataset.view = view;
  document.querySelector('.heading h1').textContent = shell[0];
  document.getElementById('page-context').textContent = name;
  document.getElementById('page-description').textContent = shell[1];
  for (const button of document.querySelectorAll('.shell-nav [data-view]'))
    button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false');
}

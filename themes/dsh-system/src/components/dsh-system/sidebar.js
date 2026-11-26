'use strict';

(function () {
  const groupKey = 'dsh-system.sidebar-group';
  CS.group = store.get(groupKey, 'project');
  onRender(() => {
    if (store.get(groupKey, 'project') !== CS.group) store.set(groupKey, CS.group);
  });

  const drawNav = PDL_COMPONENTS.navShell;
  PDL_COMPONENTS.navShell = function (props, scope, root) {
    if (pv(props.scrollId, scope, root) !== 'cafe-nav-scroll') return drawNav(props, scope, root);
    const start = '<div class="nav-scroll scroll" id="cafe-nav-scroll">';
    const shortcuts = pdlSlot(pv(props.slot, scope, root));
    const label = S.lang === 'en' ? 'All works' : '全部作品';
    const workspaceLabel = S.lang === 'en' ? 'Workspace' : '工作区';
    const works = shortcuts.includes('data-entry="works"') ? '' : navItem('works', 'works', label);
    const tools = pvControls(props.actions, scope, root);
    const activity = btn(S.lang === 'en' ? 'Live activity' : '正在发生', {
      act: 'wsTool', iconOnly: true, icon: 'pulse', data: argAttrs({ k: 'home' })
    });
    const toggle = btn(S.lang === 'en' ? 'Collapse sidebar' : '收起侧栏', {
      act: 'toggle', iconOnly: true, icon: 'split2', data: argAttrs({ path: 'cs.navHidden' })
    });
    return drawNav({ ...props, slot: null, actions: [] }, scope, root).replace(start, () =>
      start + '<div class="dsh-shortcuts">' + shortcuts + works + '</div>' +
      '<div class="dsh-workspace-label"><span>' + h(workspaceLabel) + '</span>' + activity + tools + toggle + '</div>');
  };
  PDL_COMPONENTS.navShell.catalog = drawNav.catalog;

  const drawSections = PDL_BLOCKS.threads;
  PDL_BLOCKS.threads = function (block, scope, root) {
    if (PV.viewId !== 'nav.threads') return drawSections(block, scope, root);
    const project = { ...block.groups.proj, limit: 's' };
    const sections = root.group === 'project' ? root.sections.map(section => ({
      ...section,
      rows: [...section.rows].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
    })).sort((a, b) => Number(a.head?.id === 'default') - Number(b.head?.id === 'default'))
      : root.sections;
    return drawSections({
      ...block,
      groups: { ...block.groups, proj: project },
      heads: { ...block.heads, proj: { ...block.heads.proj, icon: 'folder' } }
    }, scope, { ...root, sections });
  };

  const drawRow = threadRow;
  threadRow = function (row, declaration, root, movable) {
    const state = row.running || row.runs?.length ? 'running' : row.unread > 0 ? 'unread' : '';
    const html = drawRow({ ...row, unread: 0, lastWho: row.cur ? row.lastWho : null }, declaration, root, movable)
      .replace('<span class="lr-sub">&#8203;</span>', '');
    if (!state) return html;
    const label = state === 'running'
      ? (S.lang === 'en' ? 'Running' : '运行中')
      : (S.lang === 'en' ? 'Unread' : '有未读消息');
    const status = '<span class="dsh-thread-status" data-dsh-status="' + state +
      '" role="img" aria-label="' + h(label) + '"></span>';
    return html.replace(/(<div class="lr-head"[^>]*>)/, '$1' + status);
  };

  const armTip = tipArm;
  tipArm = function (anchor) {
    if (S.menu) return tipHide();
    return armTip(anchor);
  };
  const showTip = tipShow;
  tipShow = function (anchor) {
    if (S.menu) return tipHide();
    return showTip(anchor);
  };
  onRender(() => {
    if (S.menu && TIP.at) tipHide();
  });
})();
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
      act: 'toggle', iconOnly: true, icon: 'split2', cls: 'dsh-sidebar-collapse',
      data: argAttrs({ path: 'cs.navHidden' })
    });
    return drawNav({ ...props, slot: null, actions: [] }, scope, root).replace(start, () =>
      start + '<div class="dsh-shortcuts">' + shortcuts + works + '</div>' +
      '<div class="dsh-workspace-label"><span>' + h(workspaceLabel) + '</span>' + activity + tools + toggle + '</div>');
  };
  PDL_COMPONENTS.navShell.catalog = drawNav.catalog;

  // Move explicit leading references out of the title display. Keep the raw title for rename and search.
  const titleRef = /^(?:(host|plugins?|clowder-ai(?:-plugins)?|[\w.-]+\/[\w.-]+)[ 	]+)?(issue|pr)[ 	]*#[ 	]*(\d+)(?=$|[\s:：,，、/|·–—-])/i;
  function titleParts(title) {
    const refs = [];
    let subject = title;
    let match;
    while ((match = titleRef.exec(subject))) {
      const [, repo, kind, number] = match;
      refs.push((repo ? repo + ' ' : '') + (kind.toLowerCase() === 'pr' ? 'PR' : 'Issue') + '#' + number);
      subject = subject.slice(match[0].length).replace(/^[\s:：,，、/|·–—-]+/, '');
    }
    return { subject: subject || title, refs };
  }

  const labelText = (zh, en) => S.lang === 'en' ? en : zh;
  const editLabels = () => labelText('编辑标签', 'Edit labels');
  let labelEditor = null;

  A.dshLabelsClose = function () {
    const id = labelEditor?.id;
    if (!id) return;
    labelEditor = null;
    render(true);
    const row = document.querySelector('#cafe-nav-scroll [data-tid="' + CSS.escape(id) + '"]');
    (row?.querySelector('.dsh-thread-labels') || row?.querySelector('.lr-acts [data-act="menu"]'))?.focus();
  };
  A.dshLabelsEdit = function (d) {
    if (labelEditor?.id === d.id) return A.dshLabelsClose();
    labelEditor = { id: d.id, openedIn: chatPort.threadId, draft: '', busy: false, error: '' };
    render(true);
    document.getElementById('dsh-thread-label-input')?.focus();
  };
  INPUTS.dshLabelDraft = function (e) {
    labelEditor.draft = e.target.value;
  };
  A.dshLabelChange = async function (d) {
    const edit = labelEditor;
    if (!edit || edit.busy) return;
    const name = edit.draft.trim();
    const ids = sidebarData().threads.find(thread => thread.id === edit.id)?.labels || [];
    if (!d.remove && !name) return;
    if (!d.remove && ids.some(id => sidebarOwner().labels.some(label => label.id === id && label.name === name))) {
      edit.error = labelText('这条会话已有同名标签', 'This conversation already has that label');
      render(true);
      return;
    }
    if (!d.remove && ids.length >= 20) {
      edit.error = labelText('每条会话最多 20 个标签', 'A conversation can have up to 20 labels');
      render(true);
      return;
    }
    edit.busy = true;
    edit.error = '';
    render(true);
    try {
      if (!d.remove && edit.created?.name !== name) {
        edit.created = await api.post('/api/labels', {}, { name, color: '#7b8794' });
      }
      const current = sidebarData().threads.find(thread => thread.id === edit.id)?.labels || [];
      const next = d.remove ? current.filter(id => id !== d.remove) : [...new Set([...current, edit.created.id])];
      await chatPort.action('sidebarLabels', { id: edit.id, value: JSON.stringify(next) });
      if (!d.remove) {
        edit.draft = '';
        edit.created = null;
        await chatPort.action('sidebarRead', {});
      }
    } catch (error) {
      edit.error = error.message;
    } finally {
      edit.busy = false;
      render(true);
      if (labelEditor === edit) document.getElementById('dsh-thread-label-input')?.focus();
    }
  };

  const navThreads = VM.navThreads;
  VM.navThreads = function () {
    const model = navThreads();
    if (labelEditor && labelEditor.openedIn !== chatPort.threadId) labelEditor = null;
    const byId = new Map((sidebarOwner()?.labels || []).map(label => [label.id, { id: label.id, name: label.name }]));
    const dshLabels = Object.fromEntries(sidebarData().threads.filter(thread => thread.labels?.length).map(thread => [
      thread.id, thread.labels.map(id => byId.get(id)).filter(Boolean)
    ]));
    return { ...model, dshLabels, dshLabelEdit: labelEditor && { ...labelEditor } };
  };

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
    if (row.renaming) return drawRow(row, declaration, root, movable);
    const state = row.running || row.runs?.length ? 'running' : row.unread > 0 ? 'unread' : '';
    const tags = root?.dshLabels;
    const { subject, refs } = tags ? titleParts(row.title) : { subject: row.title, refs: [] };
    const assigned = tags?.[row.id] || [];
    const labels = [...new Set([...assigned.map(label => label.name), ...refs])];
    const edit = { label: editLabels(), act: 'dshLabelsEdit', args: { id: '@id' } };
    const controls = tags && declaration?.more
      ? { ...declaration, more: { ...declaration.more, items: [edit, ...declaration.more.items] } }
      : declaration;
    let html = drawRow({ ...row, title: subject, unread: 0, lastWho: row.cur ? row.lastWho : null },
      controls, root, movable);
    if (subject !== row.title) {
      html = html.replace(' data-tip="' + h(subject) + '"', () => ' data-tip="' + h(row.title) + '"');
    }
    const editor = root?.dshLabelEdit?.id === row.id ? root.dshLabelEdit : null;
    if (labels.length || editor) {
      const detail = labels.join(' · ');
      const chips = labels.slice(0, 4).map(label => '<span class="dsh-thread-label">' + h(label) + '</span>').join('');
      const more = labels.length > 4 ? '<span class="dsh-label-overflow">+' + (labels.length - 4) + '</span>' : '';
      const trigger = labels.length && !editor ? '<span class="lr-sub"><button type="button" class="dsh-thread-labels"' +
        actAttrs('dshLabelsEdit', { id: row.id }) +
        ' aria-expanded="false" aria-label="' + h(editLabels() + ' · ' + detail) + '" data-tip="' + h(detail) + '">' +
        chips + more + '</button></span>' : '';
      let panel = '';
      if (editor) {
        const disabled = editor.busy ? ' disabled' : '';
        const removable = assigned.map(label =>
          '<button type="button" class="dsh-label-remove"' + actAttrs('dshLabelChange', { remove: label.id }) +
          ' aria-label="' + h(labelText('移除 ', 'Remove ') + label.name) + '"' + disabled + '><span>' +
          h(label.name) + '</span>' + icon('close', 11) + '</button>').join('');
        const titleRefs = refs.filter(ref => !assigned.some(label => label.name === ref));
        panel = '<span class="dsh-thread-label-editor" role="group" aria-label="' + h(editLabels()) + '">' +
          (removable ? '<span class="dsh-label-edits">' + removable + '</span>' : '') +
          (titleRefs.length ? '<span class="dsh-label-origin">' + h(labelText('标题编号 · ', 'From the title · ') + titleRefs.join(' · ')) + '</span>' : '') +
          '<span class="dsh-label-entry"><input id="dsh-thread-label-input" class="input" maxlength="20"' +
          ' data-input="dshLabelDraft" data-on-enter="dshLabelChange" data-on-esc="dshLabelsClose" value="' + h(editor.draft) +
          '" placeholder="' + h(labelText('添加到此会话', 'Add to this conversation')) +
          '" aria-label="' + h(labelText('标签名称', 'Label name')) + '"' + disabled + '>' +
          '<button type="button"' + actAttrs('dshLabelChange', {}) + disabled + '>' + h(labelText('添加', 'Add')) + '</button>' +
          '<button type="button"' + actAttrs('dshLabelsClose', {}) + '>' + h(labelText('完成', 'Done')) + '</button></span>' +
          (editor.error ? '<span role="alert">' + h(editor.error) + '</span>' : '') + '</span>';
      }
      html = html.replace('<span class="lr-sub">', () =>
        trigger + panel + '<span class="lr-sub">');
    }
    html = html.replace('<span class="lr-sub">&#8203;</span>', '');
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

'use strict';

(function () {
  const tr = (zh, en) => S.lang === 'en' ? en : zh;
  const icons = Object.fromEntries([
    ['image', 'png jpg jpeg gif webp svg avif ico bmp'],
    ['video', 'mp4 webm mov mkv'],
    ['audio', 'mp3 wav ogg m4a flac'],
    ['grid', 'csv tsv xls xlsx ods'],
    ['archive', 'zip tar gz 7z rar'],
    ['code', 'ts tsx js jsx mjs cjs html css json jsonl yaml yml toml py rs go sh ps1 sql xml']
  ].flatMap(([kind, extensions]) => extensions.split(' ').map(extension => [extension, kind])));

  const drawFileRow = pvRow;
  pvRow = function (template, row, root, listId) {
    const result = drawFileRow(template, row, root, listId);
    if (PV.viewId !== 'ws.files' || template !== 'file.row' || !row.path) return result;
    const extension = row.path.toLowerCase().split('.').pop();
    const kind = row.dir ? 'directory'
      : /^(md|markdown|mdx)$/.test(extension) ? 'markdown'
      : Object.hasOwn(icons, extension) ? icons[extension] : 'file';
    const mark = kind === 'markdown' ? 'MD' : icon(kind === 'directory' ? 'folder' : kind, 15);
    const opened = workbenchModels().filePage;
    return {
      ...result,
      cur: opened?.worktreeId === S.ws.wt && opened?.filePath === row.path,
      lead: '<span class="dsh-file-icon" data-kind="' + kind + '" aria-hidden="true">' + mark + '</span>'
    };
  };
  A.dshCopyFileSource = (data, button) => {
    const file = workbenchModels().filePage;
    if (file?.hasBody && file.filePath === data.path && file.worktreeId === data.worktreeId)
      copyText(file.body, button);
  };

  const drawToolbar = PDL_BLOCKS.toolbar;
  PDL_BLOCKS.toolbar = function (block, scope, root) {
    const isFileToolbar = PV.viewId === 'file.body' &&
      block.items.some(item => item.type === 'seg' && item.args?.path === 'ws.fileMode');
    if (!isFileToolbar || !root.markdown || root.editing || root.mode !== 'src' || !root.hasBody)
      return drawToolbar(block, scope, root);
    const copy = {
      type: 'button', icon: 'copy',
      label: tr('复制源码', 'Copy source'),
      act: 'dshCopyFileSource',
      args: { path: '$.filePath', worktreeId: '$.worktreeId' }
    };
    return drawToolbar({ ...block, items: [block.items[0], copy, ...block.items.slice(1)] }, scope, root);
  };

  const drawMarkdown = PDL_BLOCKS.markdown;
  PDL_BLOCKS.markdown = function (block, scope, root) {
    if (PV.viewId !== 'file.body' || block.text?.of !== '$.hasBody' || !root.hasBody) return drawMarkdown(block, scope, root);
    const text = root.body;
    const front = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    if (!front || root.annotations?.length) return drawMarkdown(block, scope, root);
    const fields = front[1].split(/\r?\n(?=[\w.-]+:)/)
      .map(field => /^([\w.-]+):[ \t]*([\s\S]*)$/.exec(field));
    if (!fields.every(Boolean)) return drawMarkdown(block, scope, root);

    return '<dl class="dsh-file-metadata">' + fields.map(([, key, value]) =>
      '<dt>' + h(key) + '</dt><dd>' + h(value.replace(/^[>|][+-]?[ \t]*\r?\n/, '').trim()) +
      '</dd>').join('') + '</dl>' +
      drawMarkdown({ ...block, text: { lit: text.slice(front[0].length) } }, scope, root);
  };

  onRender(() => {
    document.querySelectorAll('.dsh-file-tree .lr-node[data-open]').forEach(node => {
      node.querySelector(':scope > .lr > .lr-head')?.setAttribute('aria-expanded', node.dataset.open);
    });
  });
  const drawLoad = PV_DRAW.viewLoad;
  PV_DRAW.viewLoad = function (view, load, root) {
    if (PV.viewId !== 'ws.files' || load !== 'error') return drawLoad(view, load, root);
    const message = root.wt
      ? tr('无法读取项目文件，请确认目录可访问。', 'Could not read the project files.')
      : tr('暂无可显示的项目文件，请确认会话已关联可访问的工作区。', 'No project files are available. Check the conversation workspace.');
    return emptyState(message) + btn(tr('重试', 'Retry'), { act: 'refresh', data: argAttrs({ k: 'files' }) });
  };

  const drawList = PDL_BLOCKS.list;
  PDL_BLOCKS.list = function (block, scope, root) {
    if (PV.viewId !== 'ws.files' || block.id !== 'wcFind') return drawList(block, scope, root);
    const withQuote = {
      ...block.item,
      actsCtx: { path: '@path', quote: { of: ["\u0060", '@path', "\u0060"], sep: '' }, dir: false }
    };
    return drawList({ ...block, item: withQuote }, scope, root);
  };

  const drawTree = PDL_BLOCKS.tree;
  PDL_BLOCKS.tree = function (block, scope, root) {
    if (PV.viewId !== 'ws.files' || block.id !== 'wcFiles') return drawTree(block, scope, root);
    const children = pv(block.nodes, scope, root);
    if (!children?.['']?.length) return emptyState(tr('这个工作区目录没有文件。',
      'This workspace folder is empty.'));
    const item = { ...block.item, actsCtx: '@actsCtx' };
    return '<div class="dsh-file-tree">' + drawTree({ ...block, item }, scope, root) + '</div>';
  };
})();
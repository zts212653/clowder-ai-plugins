(function () {
  'use strict';
  var F = window.SGFormat;
  var M = window.SGModel;

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'text') node.textContent = String(value);
        else if (key === 'class') node.className = value;
        else if (key.slice(0, 2) === 'on' && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
        else if (key === 'disabled' || key === 'hidden' || key === 'checked') node[key] = Boolean(value);
        else node.setAttribute(key, String(value));
      });
    }
    append(node, children);
    return node;
  }

  function append(node, children) {
    if (children === null || children === undefined) return;
    if (Array.isArray(children)) {
      children.forEach(function (child) {
        append(node, child);
      });
      return;
    }
    if (children instanceof Node) node.appendChild(children);
    else node.appendChild(document.createTextNode(String(children)));
  }

  function clear(node) {
    if (node) node.replaceChildren();
  }

  function stat(label, value, note, primary) {
    return el('div', { class: primary ? 'stat stat-primary' : 'stat' }, [
      el('div', { class: 'stat-label', text: label }),
      el('div', { class: 'stat-value', text: value }),
      note ? el('div', { class: 'stat-note', text: note }) : null,
    ]);
  }

  function sectionHead(title, note, actions) {
    return el('div', { class: 'section-head' }, [
      el('div', {}, [
        el('h2', { class: 'section-title', text: title }),
        note ? el('p', { class: 'section-note', text: note }) : null,
      ]),
      actions ? el('div', { class: 'section-actions' }, actions) : null,
    ]);
  }

  function progressBar(percent, label, indeterminate) {
    var fill = percent === null ? 0 : percent;
    var attrs = {
      class: 'bar' + (indeterminate ? ' is-indeterminate' : percent === null ? ' is-pending' : ''),
      role: 'progressbar',
      'aria-label': label,
      'aria-valuemin': '0',
      'aria-valuemax': '100',
    };
    if (indeterminate) attrs['aria-valuetext'] = '正在扫描，暂无精确进度';
    else attrs['aria-valuenow'] = percent === null ? '0' : String(Math.round(percent));
    return el(
      'div',
      attrs,
      el('span', { style: indeterminate ? null : { width: fill + '%' } }),
    );
  }

  function renderTotals(summary) {
    var totals = summary.totals;
    return el('div', { class: 'totals' }, [
      stat('磁盘占用', F.bytesText(totals.allocatedBytes), '这次扫描测得的落盘空间，已去重', true),
      stat('文件大小', F.bytesText(totals.logicalBytes), '文件显示大小的合计'),
      stat('文件', F.countText(totals.fileCount), F.countText(totals.volumeCount) + ' 个卷'),
    ]);
  }

  function renderVolumes(summary) {
    var volumes = summary.volumes || [];
    if (volumes.length === 0) {
      return el('p', { class: 'section-empty', text: '这次扫描没有读到卷信息。' });
    }
    var cards = volumes.map(function (volume) {
      var known = volume.totalBytes !== null && volume.freeBytes !== null;
      var used = known ? Math.max(0, volume.totalBytes - volume.freeBytes) : null;
      var usedPercent = known ? F.percent(used, volume.totalBytes) : null;
      var shareText =
        volume.appAllocatedBytes !== null && volume.totalBytes > 0
          ? '占本盘总容量 ' + F.percentText(volume.appAllocatedBytes, volume.totalBytes)
          : '占本盘比例未知';
      return el('article', { class: 'volume-card' }, [
        el('div', { class: 'volume-head' }, [
          el('span', { class: 'volume-id', text: volume.id }),
          volume.fsType ? el('span', { class: 'volume-fs', text: volume.fsType }) : null,
        ]),
        known
          ? progressBar(usedPercent, volume.id + ' 已用 ' + F.percentText(used, volume.totalBytes))
          : el('p', { class: 'volume-unknown', text: '卷容量未读取' }),
        el('div', { class: 'volume-meta' }, [
          el('span', {
            text: known
              ? '已用 ' + F.bytesText(used) + ' / ' + F.bytesText(volume.totalBytes)
              : '已用未知 / 共未知',
          }),
          el('span', { text: known ? '可用 ' + F.bytesText(volume.freeBytes) : '可用未知' }),
        ]),
        el('div', { class: 'volume-app' }, [
          el('strong', { text: '本应用占用 ' + F.bytesText(volume.appAllocatedBytes) }),
          el('span', {
            text:
              '文件大小 ' + F.bytesText(volume.appLogicalBytes) +
              ' · ' +
              F.countText(volume.fileCount) +
              ' 个文件',
          }),
          el('span', { class: 'volume-share', text: shareText }),
        ]),
      ]);
    });
    return el('div', { class: 'volume-grid' }, cards);
  }

  function renderCategories(summary, handlers) {
    var selected = handlers.category || '';
    var rows = (summary.categories || []).map(function (category) {
      var share = F.percent(category.allocatedBytes, summary.totals.allocatedBytes);
      var reclaim =
        category.reclaimableBytes === null
          ? category.retention === 'protected'
            ? '受保护'
            : '未知'
          : F.bytesText(category.reclaimableBytes);
      var active = selected === category.id;
      var row = el(
        'tr',
        {
          class: 'category-row' + (active ? ' is-selected' : ''),
          tabindex: '0',
          'aria-selected': active ? 'true' : 'false',
          'aria-label': '筛选类别：' + category.label,
          onClick: function () {
            handlers.onCategory(category.id);
          },
          onKeydown: function (event) {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              handlers.onCategory(category.id);
            }
          },
        },
        [
          el('td', {}, [
            el('div', { class: 'category-name', text: category.label }),
            el(
              'div',
              { class: 'share', 'aria-hidden': 'true' },
              el('span', { style: { width: (share === null ? 0 : share) + '%' } }),
            ),
          ]),
          el('td', { class: 'num usage', text: F.bytesText(category.allocatedBytes) }),
          el('td', { class: 'num', text: F.bytesText(category.logicalBytes) }),
          el('td', { class: 'num', text: reclaim }),
          el('td', { class: 'num', text: F.countText(category.fileCount) }),
          el('td', {}, el('span', { class: 'retain retain-' + category.retention, text: M.retainLabel(category.retention) })),
        ],
      );
      return row;
    });
    return el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data-table category-table' }, [
        el('caption', { class: 'sr-only', text: '按类别汇总的占用' }),
        el('thead', {}, el('tr', {}, [
          el('th', { scope: 'col', text: '类别' }),
          el('th', { scope: 'col', class: 'num usage', text: '磁盘占用' }),
          el('th', { scope: 'col', class: 'num', text: '文件大小' }),
          el('th', { scope: 'col', class: 'num', text: '可回收估算' }),
          el('th', { scope: 'col', class: 'num', text: '文件' }),
          el('th', { scope: 'col', text: '保留' }),
        ])),
        el('tbody', {}, rows),
      ]),
    ]);
  }

  function renderWorktrees(page, handlers) {
    if (!page) return el('div', { class: 'table-loading', text: '正在读取工作树汇总…' });
    if (page.unavailable) {
      return el('div', { class: 'table-empty' }, [
        el('p', { text: '当前 Host 没有返回完整的工作树汇总，不能显示可能不完整的目录合计。请重新扫描或更新 Host 后重试。' }),
        handlers.onScan
          ? el('button', { class: 'btn ghost', type: 'button', text: '重新扫描', onClick: handlers.onScan })
          : null,
      ]);
    }
    if (page.rows.length === 0) {
      return el('div', { class: 'table-empty' }, [
        el('p', { text: handlers.filtered ? '没有匹配的工作树。' : '这次扫描没有工作树目录。' }),
        handlers.filtered
          ? el('button', { class: 'btn ghost', type: 'button', text: '清除筛选', onClick: handlers.onClearFilters })
          : null,
      ]);
    }
    var rows = page.rows.map(function (row) {
      var cells = [
        el('td', { class: 'path-cell' }, [
          el('span', { class: 'path-text', title: row.path, text: row.path }),
          el('span', { class: 'row-flag', text: '目录' }),
        ]),
        el('td', { class: 'mono', text: row.volumeId }),
        el('td', { class: 'num usage', text: F.bytesText(row.allocatedBytes) }),
        el('td', { class: 'num', text: F.bytesText(row.logicalBytes) }),
        el('td', { class: 'num', text: F.countText(row.fileCount) }),
        el('td', { class: 'source-cell' }, [
          el('span', { class: 'source-label', text: M.sourceLabel(row.source) }),
          row.source.id ? el('span', { class: 'source-id', text: row.source.id }) : null,
        ]),
      ];
      return el(
        'tr',
        {
          class: 'file-row worktree-row',
          tabindex: '0',
          'aria-label': '展开工作树：' + row.path,
          onClick: function () {
            handlers.onDirectory(row);
          },
          onKeydown: function (event) {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              handlers.onDirectory(row);
            }
          },
        },
        cells,
      );
    });
    return el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data-table worktree-table' }, [
        el('caption', { class: 'sr-only', text: '按实际工作树目录汇总的占用' }),
        el('thead', {}, el('tr', {}, [
          el('th', { scope: 'col', text: '工作树目录' }),
          el('th', { scope: 'col', text: '卷' }),
          el('th', { scope: 'col', class: 'num usage', text: '磁盘占用', 'aria-sort': 'descending' }),
          el('th', { scope: 'col', class: 'num', text: '文件大小' }),
          el('th', { scope: 'col', class: 'num', text: '文件', title: '该工作树目录内的路径数（含重复路径）' }),
          el('th', { scope: 'col', text: '来源' }),
        ])),
        el('tbody', {}, rows),
      ]),
    ]);
  }

  function renderFiles(page, handlers) {
    if (!page) return el('div', { class: 'table-loading', text: '正在读取文件清单…' });
    if (page.rows.length === 0) {
      return el('div', { class: 'table-empty' }, [
        el('p', { text: handlers.filtered ? '没有匹配的文件。' : '这次扫描没有逐文件结果。' }),
        handlers.filtered
          ? el('button', { class: 'btn ghost', type: 'button', text: '清除筛选', onClick: handlers.onClearFilters })
          : null,
      ]);
    }
    var showModified = page.rows.some(function (row) {
      return row.modifiedAt !== null;
    });
    var headers = [
      el('th', { scope: 'col', text: '类型' }),
      el('th', { scope: 'col', text: '路径' }),
      el('th', { scope: 'col', text: '工作树' }),
      el('th', { scope: 'col', text: '类别' }),
      el('th', { scope: 'col', text: '来源' }),
      el('th', { scope: 'col', text: '卷' }),
      el('th', { scope: 'col', class: 'num usage', text: '磁盘占用', 'aria-sort': 'descending' }),
      el('th', { scope: 'col', class: 'num', text: '文件大小' }),
    ];
    if (showModified) headers.push(el('th', { scope: 'col', text: '修改时间' }));
    var rows = page.rows.map(function (row) {
      var flag = row.flags.length > 0 ? row.flags[0] : null;
      var type = M.fileType(row.path);
      var cells = [
        el('td', {}, el('span', {
          class: 'tag type-tag type-' + type.id,
          title: type.note ? type.label + ' · ' + type.note : type.label,
          text: type.label,
        })),
        el('td', { class: 'path-cell' }, [
          el('span', { class: 'path-text', title: row.path, text: row.path }),
          flag
            ? el('span', {
                class: 'row-flag',
                title: row.flags.map(M.flagLabel).join('、'),
                text: M.flagLabel(flag),
              })
            : null,
        ]),
        el('td', { class: 'worktree-cell' }, row.worktreePath
          ? el('span', {
              class: 'worktree-label',
              title: row.worktreePath,
              text: M.worktreeName(row.worktreePath),
            })
          : el('span', { class: 'muted', text: '—' })),
        el('td', {}, el('span', { class: 'tag', text: M.categoryLabel(row.category) })),
        el('td', { class: 'source-cell' }, [
          el('span', { class: 'source-label', text: M.sourceLabel(row.source) }),
          row.source.id ? el('span', { class: 'source-id', text: row.source.id }) : null,
        ]),
        el('td', { class: 'mono', text: row.volumeId }),
        el('td', { class: 'num usage', text: F.bytesText(row.allocatedBytes) }),
        el('td', { class: 'num', text: F.bytesText(row.logicalBytes) }),
      ];
      if (showModified) {
        cells.push(el('td', { class: 'muted nowrap', text: F.dateText(row.modifiedAt) }));
      }
      return el(
        'tr',
        {
          class: 'file-row',
          tabindex: '0',
          'aria-label': row.path,
          onClick: function (event) {
            handlers.onRow(row, event.currentTarget);
          },
          onKeydown: function (event) {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              handlers.onRow(row, event.currentTarget);
            }
          },
        },
        cells,
      );
    });
    return el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data-table file-table' }, [
        el('caption', { class: 'sr-only', text: '逐文件占用清单，按大小降序' }),
        el('thead', {}, el('tr', {}, headers)),
        el('tbody', {}, rows),
      ]),
    ]);
  }

  function renderPager(page, handlers) {
    if (!page || page.totalMatched === 0) return null;
    var offset = handlers.offset || 0;
    var start = offset + 1;
    var end = offset + page.rows.length;
    return el('div', { class: 'pager' }, [
      el('span', {
        class: 'pager-text',
        text: '第 ' + F.countText(start) + '–' + F.countText(end) + ' 条，共 ' + F.countText(page.totalMatched) + ' 条',
      }),
      el('div', { class: 'pager-actions' }, [
        el('button', {
          class: 'btn secondary',
          type: 'button',
          text: '上一页',
          disabled: offset === 0 || handlers.busy,
          onClick: handlers.onPrev,
        }),
        el('button', {
          class: 'btn secondary',
          type: 'button',
          text: '下一页',
          disabled: page.nextOffset === null || page.nextOffset === undefined || handlers.busy,
          onClick: handlers.onNext,
        }),
      ]),
    ]);
  }

  function renderUnscanned(summary) {
    if (!summary.unscanned || summary.unscanned.length === 0) return null;
    var total = typeof summary.unscannedCount === 'number' ? summary.unscannedCount : summary.unscanned.length;
    var rows = summary.unscanned.map(function (root) {
      return el('div', { class: 'fold-row' }, [
        el('div', { class: 'fold-path mono', title: root.path, text: root.path }),
        el('div', { class: 'fold-detail', text: root.reason }),
        el('div', {
          class: 'fold-side',
          text: root.affectedBytes === null ? '遗漏量未知' : '可能遗漏 ' + F.bytesText(root.affectedBytes),
        }),
      ]);
    });
    var hidden = Math.max(0, total - summary.unscanned.length);
    return el('details', { class: 'fold', open: false }, [
      el('summary', {}, [
        el('span', { text: '未扫描 ' + F.countText(total) + ' 处' }),
        el('span', { class: 'fold-hint', text: '查看原因' }),
      ]),
      el('div', { class: 'fold-body' }, [
        rows,
        hidden > 0
          ? el('p', { class: 'fold-note', text: '另有 ' + F.countText(hidden) + ' 处未逐条列出。' })
          : null,
      ]),
    ]);
  }

  function renderScope(summary) {
    if (!summary.roots || summary.roots.length === 0) return null;
    var total = typeof summary.rootsCount === 'number' ? summary.rootsCount : summary.roots.length;
    var rows = summary.roots.map(function (root) {
      return el('div', { class: 'fold-row' }, [
        el('div', { class: 'fold-path mono', title: root.path, text: root.path }),
        el('div', { class: 'fold-detail' }, [
          el('span', { class: 'tag', text: M.roleLabel(root.role) }),
          el('span', { class: 'fold-sep', text: '·' }),
          el('span', { text: M.categoryLabel(root.category) }),
        ]),
        el('div', {
          class: 'fold-side',
          text: root.included
            ? '已纳入' + (root.reason ? ' · ' + root.reason : '')
            : '未纳入' + (root.reason ? ' · ' + root.reason : ''),
        }),
      ]);
    });
    var hidden = Math.max(0, total - summary.roots.length);
    return el('details', { class: 'fold', open: false }, [
      el('summary', {}, [
        el('span', { text: '扫描范围 · ' + F.countText(total) + ' 个根' }),
        el('span', { class: 'fold-hint', text: 'Host 登记' }),
      ]),
      el('div', { class: 'fold-body' }, [
        rows,
        hidden > 0
          ? el('p', { class: 'fold-note', text: '另有 ' + F.countText(hidden) + ' 个根未逐条列出。' })
          : null,
      ]),
    ]);
  }

  function renderProgress(scan, handlers) {
    var percent = M.scanProgressPercent(scan);
    var progress = scan.progress;
    var elapsed = scan.startedAt ? Math.max(0, Date.now() - scan.startedAt) : 0;
    var meta = progress.rootsTotal > 0
      ? [
          M.phaseLabel(progress.phase),
          F.countText(progress.rootsDone) + ' / ' + F.countText(progress.rootsTotal) + ' 个扫描范围',
          F.countText(progress.filesSeen) + ' 个文件',
        ].join(' · ')
      : M.phaseLabel(progress.phase);
    meta += ' · 已用 ' + F.durationText(elapsed);
    var estimate = handlers.estimate || { text: '正在估算…', detail: '' };
    return el('div', { class: 'progress-card', role: 'status' }, [
      el('div', { class: 'progress-head' }, [
        el('div', {}, [
          el('strong', { text: F.stateText(scan.state) }),
          el('span', { class: 'progress-meta', text: meta }),
        ]),
        handlers.onCancel
          ? el('button', {
              class: 'btn ghost',
              type: 'button',
              text: '停止扫描',
              disabled: scan.state !== 'queued' && scan.state !== 'scanning',
              onClick: handlers.onCancel,
            })
          : null,
      ]),
      progressBar(percent, '扫描范围进度', percent === null || percent === 0),
      el('div', { class: 'progress-estimate' }, [
        el('strong', { text: estimate.text }),
        estimate.detail ? el('span', { text: estimate.detail }) : null,
      ]),
      progress.currentRoot
        ? el('div', { class: 'progress-current mono', title: progress.currentRoot, text: progress.currentRoot })
        : null,
      scan.error ? el('p', { class: 'progress-error', text: scan.error.message }) : null,
    ]);
  }

  function renderNotice(kind, text, action) {
    return el('div', { class: 'notice notice-' + kind, role: kind === 'danger' ? 'alert' : 'status' }, [
      el('span', { class: 'notice-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'notice-text', text: text }),
      action
        ? el('button', {
            class: 'btn ghost',
            type: 'button',
            text: action.label,
            onClick: action.onClick,
          })
        : null,
    ]);
  }

  function renderEmpty(kind, options, handlers) {
    var content = {
      loading: {
        title: '正在读取存储清单…',
        body: '第一次打开会读取 Host 提供的扫描范围和上一次结果。',
        action: null,
      },
      unavailable: {
        title: '需要更新 Host',
        body: options.reason || '当前 Host 版本还不支持存储清单。插件不会自行猜测数据目录。',
        action: null,
      },
      idle: {
        title: '还没有扫描结果',
        body: '扫描会读取 Host 登记的会话、附件、作品、工作树与缓存目录，只统计大小和来源，不改动任何文件。',
        action: { label: '开始扫描', onClick: handlers.onScan },
      },
      error: {
        title: '存储清单读取失败',
        body: options.reason || '请稍后重试；如果一直失败，检查 Host 是否在运行。',
        action: { label: '重试', onClick: handlers.onReload },
      },
    }[kind];
    var nodes = [el('h2', { class: 'empty-title', text: content.title }), el('p', { class: 'empty-body', text: content.body })];
    if (content.action) {
      nodes.push(
        el('button', {
          class: 'btn ' + (kind === 'idle' ? 'primary' : 'secondary'),
          type: 'button',
          text: content.action.label,
          onClick: content.action.onClick,
        }),
      );
    }
    if (kind === 'unavailable') {
      nodes.push(el('p', { class: 'empty-note', text: '存储空间治理不会读取或猜测任意磁盘路径。' }));
    }
    return el('div', { class: 'empty-state empty-' + kind }, nodes);
  }

  function renderDrawer(row, handlers) {
    if (!row) return null;
    var flags = row.flags.map(function (flag) {
      return el('span', { class: 'tag', text: M.flagLabel(flag) });
    });
    return el('div', { class: 'drawer-card' }, [
      el('div', { class: 'drawer-head' }, [
        el('h2', { class: 'drawer-title', text: '文件详情' }),
        el('button', {
          class: 'btn ghost',
          type: 'button',
          text: '关闭',
          onClick: handlers.onClose,
        }),
      ]),
      el('div', { class: 'drawer-body' }, [
        el('div', { class: 'drawer-path mono', text: row.path }),
        el('div', { class: 'drawer-actions' }, [
          el('button', {
            class: 'btn secondary',
            type: 'button',
            text: '复制路径',
            onClick: function () {
              handlers.onCopy(row.path);
            },
          }),
        ]),
        el('dl', { class: 'detail-list' }, [
          detail('类型', M.fileType(row.path).label),
          detail('工作树', row.worktreePath || '不属于工作树'),
          detail('类别', M.categoryLabel(row.category)),
          detail('来源', M.sourceLabel(row.source)),
          detail('来源标识', row.source.id || '未提供'),
          detail('卷', row.volumeId),
          detail('磁盘占用', F.bytesText(row.allocatedBytes)),
          detail('文件大小', F.bytesText(row.logicalBytes)),
          detail('修改时间', F.dateText(row.modifiedAt)),
          detail('保留属性', M.retainLabel(row.retention)),
        ]),
        flags.length > 0
          ? el('div', { class: 'drawer-flags' }, [el('div', { class: 'detail-label', text: '标记' }), el('div', {}, flags)])
          : null,
        el('p', { class: 'drawer-note', text: '这里只读；扫描不会移动、删除或改写文件。' }),
      ]),
    ]);
  }

  function detail(label, value) {
    return el('div', { class: 'detail-row' }, [
      el('dt', { class: 'detail-label', text: label }),
      el('dd', { class: 'detail-value', text: value }),
    ]);
  }

  window.SGRender = {
    el: el,
    clear: clear,
    renderTotals: renderTotals,
    renderVolumes: renderVolumes,
    renderCategories: renderCategories,
    renderWorktrees: renderWorktrees,
    renderFiles: renderFiles,
    renderPager: renderPager,
    renderUnscanned: renderUnscanned,
    renderScope: renderScope,
    renderProgress: renderProgress,
    renderNotice: renderNotice,
    renderEmpty: renderEmpty,
    renderDrawer: renderDrawer,
  };
})();

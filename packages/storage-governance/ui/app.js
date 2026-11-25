(function () {
  'use strict';
  var R = window.SGRender;
  var M = window.SGModel;
  var F = window.SGFormat;
  var request = window.SGBridge.request;
  var copy = window.SGBridge.copy;

  var els = {
    empty: document.getElementById('empty'),
    data: document.getElementById('data'),
    progress: document.getElementById('progress'),
    totals: document.getElementById('totals'),
    volumes: document.getElementById('volumes'),
    categories: document.getElementById('categories'),
    categoriesSection: document.getElementById('categories-section'),
    files: document.getElementById('files-table'),
    pager: document.getElementById('pager'),
    unscanned: document.getElementById('unscanned'),
    scope: document.getElementById('scope'),
    scopeSection: document.getElementById('scope-section'),
    scopeNote: document.getElementById('scope-note'),
    notice: document.getElementById('notice'),
    meta: document.getElementById('scan-meta'),
    scanBtn: document.getElementById('scan-btn'),
    search: document.getElementById('file-search'),
    volume: document.getElementById('filter-volume'),
    thread: document.getElementById('filter-thread'),
    category: document.getElementById('filter-category'),
    clear: document.getElementById('clear-filters'),
    resultCount: document.getElementById('result-count'),
    drawer: document.getElementById('drawer'),
  };

  var state = {
    phase: 'loading',
    report: null,
    summary: null,
    active: null,
    page: null,
    filters: { query: '', volume: '', threadId: '', category: '' },
    offset: 0,
    limit: 50,
    busy: false,
    filesLoading: false,
    notice: null,
    drawer: null,
    error: '',
    requestSeq: 0,
    pollTimer: null,
    searchTimer: null,
    noticeTimer: null,
  };

  function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  function nullableNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  function threadsById(report) {
    var result = {};
    (report.threads || []).forEach(function (thread) {
      if (thread && typeof thread.id === 'string') result[thread.id] = thread;
    });
    return result;
  }

  function mapVolume(volume) {
    return {
      id: String(volume.volume || '?'),
      mount: String(volume.volume || '?'),
      totalBytes: nullableNumber(volume.totalBytes),
      freeBytes: nullableNumber(volume.freeBytes),
      appLogicalBytes: num(volume.logicalBytes),
      appAllocatedBytes: volume.allocatedBytes === undefined ? null : volume.allocatedBytes,
      fileCount: num(volume.uniqueFiles === undefined ? volume.fileCount : volume.uniqueFiles),
    };
  }

  function mapCategory(category) {
    return {
      id: String(category.category || 'unknown'),
      label: M.categoryLabel(category.category),
      logicalBytes: num(category.logicalBytes),
      allocatedBytes: category.allocatedBytes === undefined ? null : category.allocatedBytes,
      reclaimableBytes: category.reclaimableBytes === undefined ? null : category.reclaimableBytes,
      fileCount: num(category.uniqueFiles === undefined ? category.fileCount : category.uniqueFiles),
      retention: M.retentionFor(category.category),
    };
  }

  function rootRole(category) {
    if (category === 'worktree') return 'worktree-root';
    if (category === 'native-session') return 'client-home';
    if (category === 'temp') return 'temp';
    return 'host-data';
  }

  function mapSummary(report) {
    var volumes = (report.volumes || []).map(mapVolume).sort(function (left, right) {
      return left.id.localeCompare(right.id);
    });
    var categories = (report.categories || []).map(mapCategory).sort(function (left, right) {
      return right.logicalBytes - left.logicalBytes || left.id.localeCompare(right.id);
    });
    var logical = 0;
    var allocated = volumes.length > 0 ? 0 : null;
    var files = 0;
    volumes.forEach(function (volume) {
      logical += volume.appLogicalBytes;
      files += volume.fileCount;
      if (volume.appAllocatedBytes === null) allocated = null;
      else if (allocated !== null) allocated += volume.appAllocatedBytes;
    });
    var reclaimable = categories.length > 0 ? 0 : null;
    categories.forEach(function (category) {
      if (category.reclaimableBytes === null) reclaimable = null;
      else if (reclaimable !== null) reclaimable += category.reclaimableBytes;
    });
    var omissions = (report.omissions || []).map(function (row) {
      var count = num(row.count);
      return {
        rootId: String(row.path || ''),
        path: String(row.path || ''),
        reasonCode: String(row.reason || ''),
        reason: M.omissionReason(row.reason) + (count > 1 ? ' · ' + count + ' 处' : ''),
        affectedBytes: null,
      };
    });
    var omissionCount = typeof report.omissionCount === 'number' ? report.omissionCount : omissions.length;
    return {
      scanId: report.scannedAt || 'current',
      state: omissions.length > 0 ? 'partial' : 'complete',
      generatedAt: Date.parse(report.scannedAt) || null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      activeScan: null,
      totals: {
        logicalBytes: logical,
        allocatedBytes: allocated,
        reclaimableBytes: reclaimable,
        fileCount: files,
        volumeCount: volumes.length,
      },
      volumes: volumes,
      categories: categories,
      roots: (report.roots || []).map(function (root) {
        return {
          id: String(root.path || ''),
          path: String(root.path || ''),
          role: rootRole(root.category),
          category: String(root.category || 'unknown'),
          included: true,
          ...(root.optional ? { reason: '可选根' } : {}),
        };
      }),
      rootsCount: typeof report.rootCount === 'number' ? report.rootCount : (report.roots || []).length,
      unscanned: omissions,
      unscannedCount: omissionCount,
      warnings: Array.isArray(report.warnings) ? report.warnings : [],
      revision: 0,
    };
  }

  function mapPage(report) {
    var threads = threadsById(report);
    var rows = (report.files || []).map(function (row) {
      var category = String(row.category || 'unknown');
      return {
        id: String(row.path || ''),
        path: String(row.path || ''),
        volumeId: String(row.volume || '?'),
        category: category,
        source: M.sourceFor(row, threads),
        logicalBytes: num(row.logicalBytes),
        allocatedBytes: row.allocatedBytes === undefined ? null : row.allocatedBytes,
        modifiedAt: nullableNumber(row.modifiedAt),
        retention: M.retentionFor(category),
        flags: row.duplicateOf ? ['hardlink-deduped'] : [],
      };
    });
    return {
      scanId: report.scannedAt || 'current',
      revision: 0,
      rows: rows,
      nextOffset: typeof report.nextOffset === 'number' ? report.nextOffset : null,
      totalMatched: typeof report.total === 'number' ? report.total : rows.length,
    };
  }

  function syntheticProgress() {
    return {
      scanId: 'current',
      state: 'scanning',
      startedAt: Date.now(),
      finishedAt: null,
      progress: { phase: 'enumerating', rootsDone: 0, rootsTotal: 0, filesSeen: 0, bytesSeen: 0 },
    };
  }

  function errorText(body) {
    if (body.error === 'host-capability-unavailable') {
      return '当前 Host 版本还不支持会话存储来源。更新 Host 后重试；插件不会自行猜测数据目录。';
    }
    if (body.error === 'sources-unavailable') return 'Host 未能读取会话存储来源。请稍后重试。';
    if (body.error === 'scan-failed') return '扫描没有完成。请重试；如果一直失败，检查 Host 日志。';
    return '扫描没有完成。请重试；如果一直失败，检查 Host 日志。';
  }

  function setNotice(kind, text, action, autoHide) {
    clearTimeout(state.noticeTimer);
    state.notice = { kind: kind, text: text, action: action };
    if (autoHide) {
      state.noticeTimer = setTimeout(function () {
        state.notice = null;
        render();
      }, 3500);
    }
    render();
  }

  function render() {
    var running = state.phase === 'running';
    var dataVisible = state.summary !== null;
    var showEmpty =
      state.phase === 'loading' ||
      state.phase === 'idle' ||
      state.phase === 'error' ||
      state.phase === 'unavailable';

    els.scanBtn.hidden = state.phase === 'unavailable';
    els.scanBtn.textContent = running ? '正在扫描…' : '开始扫描';
    els.scanBtn.disabled = running || state.busy || state.phase === 'loading';
    els.meta.textContent = metaText(running);

    R.clear(els.notice);
    if (state.notice) {
      els.notice.appendChild(R.renderNotice(state.notice.kind, state.notice.text, state.notice.action));
    }

    R.clear(els.progress);
    if (running) els.progress.appendChild(R.renderProgress(state.active || syntheticProgress(), {}));

    R.clear(els.empty);
    els.empty.hidden = !showEmpty;
    if (showEmpty) {
      var kind = state.phase === 'loading' ? 'loading' : state.phase;
      els.empty.appendChild(
        R.renderEmpty(
          kind,
          { reason: state.error },
          { onScan: startScan, onReload: function () { void boot(); } },
        ),
      );
    }

    els.data.hidden = !dataVisible;
    R.clear(els.totals);
    R.clear(els.volumes);
    R.clear(els.categories);
    R.clear(els.files);
    R.clear(els.pager);
    R.clear(els.unscanned);
    R.clear(els.scope);
    els.categoriesSection.hidden = true;
    els.scopeSection.hidden = true;
    els.scopeNote.hidden = true;

    if (!dataVisible) {
      els.resultCount.textContent = '';
      return;
    }

    els.totals.appendChild(R.renderTotals(state.summary));
    els.volumes.appendChild(R.renderVolumes(state.summary));
    els.categoriesSection.hidden = state.summary.categories.length === 0;
    if (!els.categoriesSection.hidden) {
      els.categories.appendChild(
        R.renderCategories(state.summary, {
          category: state.filters.category,
          onCategory: pickCategory,
        }),
      );
    }
    els.files.appendChild(
      R.renderFiles(state.page, {
        filtered: M.filterActive(state.filters),
        onRow: openDrawer,
        onClearFilters: clearFilters,
      }),
    );
    var pager = R.renderPager(state.page, {
      offset: state.offset,
      busy: state.filesLoading,
      onPrev: previousPage,
      onNext: nextPage,
    });
    if (pager) els.pager.appendChild(pager);
    var unscanned = R.renderUnscanned(state.summary);
    if (unscanned) els.unscanned.appendChild(unscanned);
    var scope = R.renderScope(state.summary);
    els.scopeSection.hidden = !scope;
    if (scope) {
      els.scope.appendChild(scope);
      els.scopeNote.hidden = false;
    }

    syncFilters();
    els.resultCount.textContent = resultText();
    els.clear.hidden = !M.filterActive(state.filters);
  }

  function metaText(running) {
    if (!state.summary) return '';
    var parts = [];
    if (running) parts.push('上次结果');
    if (state.summary.generatedAt !== null) parts.push('扫描于 ' + F.dateText(state.summary.generatedAt));
    if (state.summary.state === 'partial') parts.push('部分完成');
    return parts.join(' · ');
  }

  function resultText() {
    if (state.filesLoading) return '正在读取文件清单…';
    if (!state.page) return '';
    var prefix = M.filterActive(state.filters) ? '筛选后 ' : '';
    var duplicate =
      !M.filterActive(state.filters) &&
      state.page.totalMatched !== state.summary.totals.fileCount;
    return prefix + F.countText(state.page.totalMatched) + ' 个文件' +
      (duplicate ? ' · 清单含重复路径，总量按文件身份去重' : '');
  }

  function syncFilters() {
    var volumes = state.summary.volumes || [];
    fillSelect(
      els.volume,
      volumes.map(function (volume) {
        return { value: volume.id, label: volume.id };
      }),
      '全部卷',
    );
    var categories = state.summary.categories.length > 0
      ? state.summary.categories.map(function (category) {
          return {
            value: category.id,
            label: category.label + ' · ' + F.countText(category.fileCount),
          };
        })
      : M.knownCategories().map(function (id) {
          return { value: id, label: M.categoryLabel(id) };
        });
    fillSelect(els.category, categories, '全部类别');
    var threads = state.report && Array.isArray(state.report.threads) ? state.report.threads : [];
    fillSelect(
      els.thread,
      threads.map(function (thread) {
        return { value: thread.id, label: thread.title || thread.id };
      }),
      '全部来源',
    );
    els.volume.value = state.filters.volume;
    els.thread.value = state.filters.threadId;
    els.category.value = state.filters.category;
    els.volume.disabled = volumes.length === 0;
    els.thread.disabled = threads.length === 0;
    els.category.disabled = categories.length === 0;
    if (els.search.value !== state.filters.query) els.search.value = state.filters.query;
  }

  function fillSelect(select, options, allLabel) {
    var current = select.value;
    var fragment = document.createDocumentFragment();
    var all = document.createElement('option');
    all.value = '';
    all.textContent = allLabel;
    fragment.appendChild(all);
    options.forEach(function (option) {
      var node = document.createElement('option');
      node.value = option.value;
      node.textContent = option.label;
      fragment.appendChild(node);
    });
    select.replaceChildren(fragment);
    var exists = options.some(function (option) {
      return option.value === current;
    });
    select.value = exists ? current : '';
  }

  function queryFor(offset) {
    var query = { offset: String(offset), limit: String(state.limit) };
    if (state.filters.query) query.query = state.filters.query;
    if (state.filters.volume) query.volume = state.filters.volume;
    if (state.filters.threadId) query.threadId = state.filters.threadId;
    if (state.filters.category) query.category = state.filters.category;
    return query;
  }

  function fetchState() {
    return request('GET', 'scan');
  }

  function fetchPage(offset) {
    return request('POST', 'scan', { query: queryFor(offset) });
  }

  function applyBody(body) {
    if (!body || typeof body !== 'object') throw new Error('存储清单返回了空结果。');
    if (body.state === 'running') {
      state.phase = 'running';
      state.active = syntheticProgress();
      state.busy = false;
      state.filesLoading = false;
      render();
      schedulePoll(800);
      return;
    }
    if (body.state === 'idle') {
      state.phase = 'idle';
      state.active = null;
      state.summary = null;
      state.page = null;
      state.report = null;
      state.offset = 0;
      state.busy = false;
      state.filesLoading = false;
      render();
      return;
    }
    if (body.state === 'error') {
      state.active = null;
      state.busy = false;
      state.filesLoading = false;
      state.error = errorText(body);
      state.phase = state.summary
        ? 'ready'
        : body.error === 'host-capability-unavailable'
          ? 'unavailable'
          : 'error';
      render();
      if (state.summary) {
        setNotice('danger', state.error, { label: '重试', onClick: function () { void boot(); } });
      }
      return;
    }
    if (body.state === 'ready') {
      var wasRunning = state.phase === 'running';
      state.report = body;
      state.summary = mapSummary(body);
      state.page = mapPage(body);
      state.offset = 0;
      state.active = null;
      state.phase = 'ready';
      state.busy = false;
      state.filesLoading = false;
      state.error = '';
      render();
      if (wasRunning) setNotice('ok', '扫描完成。');
      return;
    }
    throw new Error('存储清单返回了未知状态。');
  }

  async function boot() {
    if (!state.summary) state.phase = 'loading';
    render();
    try {
      applyBody(await fetchState());
      if (state.phase === 'ready') applyBody(await fetchPage(0));
    } catch (error) {
      state.phase = state.summary ? 'ready' : 'error';
      state.error = error instanceof Error ? error.message : String(error);
      setNotice('danger', '读取存储清单失败：' + state.error, {
        label: '重试',
        onClick: function () { void boot(); },
      });
    }
  }

  async function startScan() {
    if (state.busy || state.phase === 'running') return;
    state.busy = true;
    state.notice = null;
    state.phase = 'running';
    state.active = syntheticProgress();
    render();
    try {
      var body = await request('POST', 'scan', {});
      applyBody(body);
    } catch (error) {
      state.busy = false;
      state.active = null;
      state.phase = state.summary ? 'ready' : 'idle';
      setNotice('danger', error instanceof Error ? error.message : String(error), {
        label: '重试',
        onClick: startScan,
      });
    }
  }

  function schedulePoll(delay) {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(poll, delay);
  }

  async function poll() {
    if (state.phase !== 'running') return;
    try {
      var body = await fetchState();
      if (body.state === 'running') {
        state.active = syntheticProgress();
        render();
        schedulePoll(1000);
        return;
      }
      if (body.state === 'ready') {
        applyBody(await fetchPage(0));
        return;
      }
      applyBody(body);
    } catch (error) {
      setNotice('warn', '扫描状态暂时读不到：' + (error instanceof Error ? error.message : String(error)));
      schedulePoll(3000);
    }
  }

  async function loadFiles(reset) {
    if (!state.summary) return;
    if (reset) state.offset = 0;
    var seq = ++state.requestSeq;
    state.filesLoading = true;
    render();
    try {
      var body = await fetchPage(state.offset);
      if (seq !== state.requestSeq) return;
      if (body.state === 'running') {
        applyBody(body);
        return;
      }
      if (body.state !== 'ready') {
        applyBody(body);
        return;
      }
      state.page = mapPage(body);
      state.filesLoading = false;
      render();
    } catch (error) {
      if (seq !== state.requestSeq) return;
      state.filesLoading = false;
      setNotice('danger', '文件清单读取失败：' + (error instanceof Error ? error.message : String(error)));
    }
  }

  function pickCategory(id) {
    state.filters.category = state.filters.category === id ? '' : id;
    void loadFiles(true);
    var target = document.getElementById('files-section');
    if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function clearFilters() {
    state.filters = { query: '', volume: '', threadId: '', category: '' };
    els.search.value = '';
    void loadFiles(true);
  }

  function nextPage() {
    if (!state.page || state.page.nextOffset === null) return;
    state.offset = state.page.nextOffset;
    void loadFiles(false);
  }

  function previousPage() {
    if (state.offset <= 0) return;
    state.offset = Math.max(0, state.offset - state.limit);
    void loadFiles(false);
  }

  function openDrawer(row) {
    state.drawer = row;
    R.clear(els.drawer);
    els.drawer.appendChild(
      R.renderDrawer(row, {
        onClose: closeDrawer,
        onCopy: function (path) {
          copy(path)
            .then(function () {
              setNotice('ok', '路径已复制。', null, true);
            })
            .catch(function (error) {
              setNotice('danger', '复制失败：' + (error instanceof Error ? error.message : String(error)));
            });
        },
      }),
    );
    els.drawer.hidden = false;
    var focusable = els.drawer.querySelector('button');
    if (focusable) focusable.focus();
  }

  function closeDrawer() {
    state.drawer = null;
    els.drawer.hidden = true;
    R.clear(els.drawer);
  }

  function bind() {
    els.scanBtn.addEventListener('click', function () { void startScan(); });
    els.search.addEventListener('input', function () {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(function () {
        state.filters.query = els.search.value.trim();
        void loadFiles(true);
      }, 300);
    });
    els.volume.addEventListener('change', function () {
      state.filters.volume = els.volume.value;
      void loadFiles(true);
    });
    els.thread.addEventListener('change', function () {
      state.filters.threadId = els.thread.value;
      void loadFiles(true);
    });
    els.category.addEventListener('change', function () {
      state.filters.category = els.category.value;
      void loadFiles(true);
    });
    els.clear.addEventListener('click', clearFilters);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !els.drawer.hidden) closeDrawer();
    });
  }

  bind();
  void boot();
})();

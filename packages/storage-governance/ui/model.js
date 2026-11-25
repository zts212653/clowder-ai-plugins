(function () {
  'use strict';
  var CATEGORY_LABELS = {
    transcript: '会话记录',
    'native-session': '会话原生记录',
    attachment: '附件',
    work: '作品与固定版本',
    worktree: '工作树',
    git: 'Git 对象',
    database: '数据库与索引',
    temp: '临时文件',
    log: '日志',
    recovery: '恢复归档',
    archive: '历史归档',
    export: '导出归档',
    cache: '缓存与临时',
    plugin: '插件数据',
    session: '会话记录',
    unknown: '未知归属',
  };
  var ROLE_LABELS = {
    'host-data': 'Host 数据',
    'client-home': '成员客户端目录',
    project: '项目目录',
    'worktree-root': '工作树根',
    temp: '临时目录',
    'plugin-data': '插件数据',
  };
  var FLAG_LABELS = {
    'hardlink-deduped': '硬链接已去重',
    'shared-object': '共享对象',
    sparse: '稀疏文件',
    'reparse-point': '重解析点',
    locked: '被占用',
    'changed-during-scan': '扫描时发生变化',
  };
  var PHASE_LABELS = {
    queued: '准备扫描',
    enumerating: '盘点目录',
    measuring: '读取文件大小',
    classifying: '归属分类',
    finalizing: '汇总结果',
  };
  var SOURCE_LABELS = {
    session: '会话',
    thread: '对话',
    project: '项目',
    work: '作品',
    worktree: '工作树',
    plugin: '插件',
    host: 'Host',
    shared: '共享',
    unknown: '未归属会话',
  };
  var RETAIN_LABELS = {
    protected: '受保护',
    rebuildable: '可重建',
    mixed: '混合',
    unknown: '未知',
  };
  var OMISSION_LABELS = {
    missing: '扫描时文件已不存在',
    unreadable: '权限不足或读取失败',
    'link-or-mount': '重解析点或跨卷链接，未跨根扫描',
    'not-regular-file': '不是普通文件',
    'size-out-of-range': '大小超出可统计范围',
    'worktree-unavailable': '工作树标记缺失或不可用',
    'temp-directory-unavailable': '临时目录不可读',
    'work-attribution-unavailable': '作品归属暂不可用，已计入共享或未归属',
  };
  var CATEGORY_RETENTION = {
    transcript: 'protected',
    'native-session': 'protected',
    attachment: 'protected',
    work: 'protected',
    worktree: 'mixed',
    git: 'protected',
    database: 'protected',
    temp: 'rebuildable',
    log: 'protected',
    recovery: 'protected',
    archive: 'protected',
    export: 'protected',
    cache: 'rebuildable',
    plugin: 'protected',
    unknown: 'unknown',
  };
  var KNOWN_CATEGORIES = [
    'transcript',
    'native-session',
    'attachment',
    'work',
    'worktree',
    'git',
    'database',
    'temp',
    'log',
  ];

  function categoryLabel(id) {
    return CATEGORY_LABELS[id] || id;
  }

  function roleLabel(role) {
    return ROLE_LABELS[role] || role;
  }

  function flagLabel(flag) {
    return FLAG_LABELS[flag] || flag;
  }

  function phaseLabel(phase) {
    return PHASE_LABELS[phase] || phase;
  }

  function sourceLabel(source) {
    var base = SOURCE_LABELS[source && source.kind] || SOURCE_LABELS.unknown;
    var label = source && source.label;
    return label ? base + ' · ' + label : base;
  }

  function retainLabel(value) {
    return RETAIN_LABELS[value] || value;
  }

  function retentionFor(category) {
    return CATEGORY_RETENTION[category] || 'unknown';
  }

  function knownCategories() {
    return KNOWN_CATEGORIES.slice();
  }

  function omissionReason(reason) {
    return OMISSION_LABELS[reason] || reason;
  }

  function sourceFor(row, threadsById) {
    var ids = Array.isArray(row.threadIds) ? row.threadIds : [];
    if (ids.length === 0) {
      if (row.category === 'git' || row.category === 'database') return { kind: 'shared' };
      return { kind: 'unknown' };
    }
    var thread = threadsById && threadsById[ids[0]];
    var label = thread && thread.title ? thread.title : ids[0];
    if (ids.length > 1) label += ' +' + (ids.length - 1);
    return { kind: 'thread', id: ids[0], label: label };
  }

  function isTerminalScan(scan) {
    return scan !== null && ['complete', 'partial', 'failed', 'cancelled'].indexOf(scan.state) >= 0;
  }

  function viewPhase(summary, active) {
    if (active !== null && ['queued', 'scanning'].indexOf(active.state) >= 0) return 'scanning';
    if (summary === null || summary.state === 'idle') return 'idle';
    return 'ready';
  }

  function scanProgressPercent(scan) {
    if (!scan || !scan.progress || scan.progress.rootsTotal <= 0) return null;
    return Math.min(100, Math.max(0, (scan.progress.rootsDone / scan.progress.rootsTotal) * 100));
  }

  function filterActive(filters) {
    return !!(filters && (filters.query || filters.volume || filters.threadId || filters.category));
  }

  function pageRange(page) {
    if (!page || !page.rows || page.rows.length === 0) return { start: 0, end: 0, total: page ? page.totalMatched : 0 };
    return { start: 1, end: page.rows.length, total: page.totalMatched };
  }

  function categoryOptions(categories) {
    return (categories || []).map(function (category) {
      return { value: category.id, label: category.label || categoryLabel(category.id), count: category.fileCount };
    });
  }

  function volumeOptions(volumes) {
    return (volumes || []).map(function (volume) {
      return { value: volume.id, label: volume.id };
    });
  }

  window.SGModel = {
    categoryLabel: categoryLabel,
    roleLabel: roleLabel,
    flagLabel: flagLabel,
    phaseLabel: phaseLabel,
    sourceLabel: sourceLabel,
    retainLabel: retainLabel,
    retentionFor: retentionFor,
    knownCategories: knownCategories,
    omissionReason: omissionReason,
    sourceFor: sourceFor,
    isTerminalScan: isTerminalScan,
    viewPhase: viewPhase,
    scanProgressPercent: scanProgressPercent,
    filterActive: filterActive,
    pageRange: pageRange,
    categoryOptions: categoryOptions,
    volumeOptions: volumeOptions,
  };
})();

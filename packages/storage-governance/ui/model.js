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
    preparing: '准备会话与存储来源',
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

  function baseName(path) {
    var parts = String(path || '').split(/[\\/]/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : String(path || '');
  }

  function extensionOf(path) {
    var name = baseName(path).toLowerCase();
    var index = name.lastIndexOf('.');
    return index > 0 && index < name.length - 1 ? name.slice(index + 1) : '';
  }

  function fileType(path) {
    if (/\.avd[\\/]snapshots[\\/][^\\/]+[\\/]ram\.img$/i.test(path))
      return { id: 'disk-image', label: '模拟器内存快照' };
    var ext = extensionOf(path);
    if (['img', 'iso', 'vhd', 'vhdx', 'qcow2', 'dmg', 'vmdk', 'wim', 'vdi'].indexOf(ext) >= 0)
      return { id: 'disk-image', label: '磁盘映像' };
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'ico', 'avif', 'heic', 'tif', 'tiff'].indexOf(ext) >= 0)
      return { id: 'image', label: '图片' };
    if (['jsonl', 'json', 'yaml', 'yml', 'toml', 'xml', 'csv', 'tsv'].indexOf(ext) >= 0)
      return { id: 'data', label: '结构化文本' };
    if (['sqlite', 'sqlite3', 'db', 'sql'].indexOf(ext) >= 0) return { id: 'database', label: '数据库' };
    if (['log', 'out', 'err'].indexOf(ext) >= 0) return { id: 'log', label: '日志' };
    if (['md', 'txt', 'rst', 'adoc'].indexOf(ext) >= 0) return { id: 'text', label: '文本' };
    if (['zip', 'tar', 'gz', 'tgz', 'zst', 'zstd', '7z', 'rar', 'bz2', 'xz'].indexOf(ext) >= 0)
      return { id: 'archive', label: '压缩包' };
    if (['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'kt', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'swift', 'sh', 'ps1', 'bat', 'cmd', 'css', 'scss', 'html', 'vue', 'svelte'].indexOf(ext) >= 0)
      return { id: 'source', label: '源码' };
    if (['exe', 'dll', 'so', 'dylib', 'bin', 'node', 'wasm'].indexOf(ext) >= 0)
      return { id: 'binary', label: '程序/二进制' };
    if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods'].indexOf(ext) >= 0)
      return { id: 'document', label: '文档' };
    if (['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'].indexOf(ext) >= 0) return { id: 'video', label: '视频' };
    if (['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'].indexOf(ext) >= 0) return { id: 'audio', label: '音频' };
    if (!ext) return { id: 'unknown', label: '无扩展名' };
    return { id: 'other', label: ext.toUpperCase() + ' 文件' };
  }

  function worktreeName(path) {
    return baseName(path) || String(path || '');
  }

  function worktreeOf(path, roots) {
    var target = String(path || '');
    var matches = (roots || []).filter(function (root) {
      if (!root || root.category !== 'worktree' || !root.path) return false;
      var prefix = String(root.path).replace(/[\\/]+$/, '') + '\\';
      var alt = String(root.path).replace(/[\\/]+$/, '') + '/';
      return target.toLowerCase() === String(root.path).toLowerCase()
        || target.toLowerCase().indexOf(prefix.toLowerCase()) === 0
        || target.toLowerCase().indexOf(alt.toLowerCase()) === 0;
    }).sort(function (left, right) {
      return String(right.path).length - String(left.path).length;
    });
    return matches.length > 0 ? String(matches[0].path) : '';
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
    baseName: baseName,
    fileType: fileType,
    worktreeName: worktreeName,
    worktreeOf: worktreeOf,
    isTerminalScan: isTerminalScan,
    viewPhase: viewPhase,
    scanProgressPercent: scanProgressPercent,
    filterActive: filterActive,
    pageRange: pageRange,
    categoryOptions: categoryOptions,
    volumeOptions: volumeOptions,
  };
})();

const MB = 1024 * 1024;
const GB = 1024 * MB;
const NOW = Date.now();

const THREADS = [
  { id: 'thread_storage', title: '存储空间治理' },
  { id: 'thread_migrate', title: 'Clowder AI 迁盘与会话数据盘点' },
  { id: 'thread_genoffice', title: 'GenOffice 多格式支持调研' },
  { id: 'thread_runtime', title: 'Runtime 源码构成与修复会话溯源' },
  { id: 'thread_plugin', title: '插件面板白屏修复' },
  { id: 'thread_dsh', title: 'DSH 快照占用调查' },
  { id: 'thread_works', title: '作品固定版本与恢复归档' },
  { id: 'thread_cache', title: '缓存与临时目录清理' },
];

const CATEGORIES = [
  { id: 'transcript', count: 3800, min: 1 * MB, max: 40 * MB, volume: 'C:', path: (i) => `C:\\Users\\Administrator\\.cat-cafe\\transcripts\\threads\\${THREADS[i % 3].id}\\${String(i).padStart(5, '0')}.jsonl` },
  { id: 'native-session', count: 2400, min: 1 * MB, max: 60 * MB, volume: 'C:', path: (i) => `C:\\Users\\Administrator\\.codex\\sessions\\2026\\11\\24\\rollout-2026-11-24T${String(i % 24).padStart(2, '0')}-${String(i % 60).padStart(2, '0')}-00-${String(i).padStart(5, '0')}.jsonl` },
  { id: 'attachment', count: 1200, min: 100 * 1024, max: 20 * MB, volume: 'C:', path: (i) => `C:\\Users\\Administrator\\.cat-cafe\\uploads\\${String(i).padStart(5, '0')}\\${((i * 2654435761) >>> 0).toString(16)}.bin` },
  { id: 'work', count: 300, min: 10 * MB, max: 2 * GB, volume: 'E:', path: (i) => `E:\\clowder-ai\\user-state\\.cat-cafe\\projects\\content-owner-v1\\blobs\\${((i * 2246822519) >>> 0).toString(16)}\\${String(i).padStart(5, '0')}` },
  { id: 'worktree', count: 4200, min: 1 * MB, max: 300 * MB, volume: 'G:', path: (i) => `G:\\AIwork\\clowder-ai\\worktrees\\host-pr-2065-storage\\packages\\${['api', 'web', 'shared'][i % 3]}\\src\\${String(i).padStart(5, '0')}.ts` },
  { id: 'git', count: 240, min: 4 * MB, max: 400 * MB, volume: 'G:', path: (i) => `G:\\AIwork\\clowder-ai\\clowder-ai-runtime\\.git\\objects\\${((i * 3266489917) >>> 0).toString(16).slice(0, 2)}\\${((i * 668265263) >>> 0).toString(16)}` },
  { id: 'database', count: 80, min: 1 * MB, max: 220 * MB, volume: 'E:', path: (i) => `E:\\clowder-ai\\user-state\\.cat-cafe\\${['messages', 'tasks', 'memory', 'sessions'][i % 4]}-${String(i).padStart(3, '0')}.sqlite` },
  { id: 'temp', count: 1600, min: 10 * 1024, max: 50 * MB, volume: 'C:', path: (i) => `C:\\Users\\Administrator\\AppData\\Local\\Temp\\dsh-workspace-changes-${String(i).padStart(5, '0')}\\objects\\${((i * 2246822519) >>> 0).toString(16)}` },
  { id: 'log', count: 150, min: 100 * 1024, max: 30 * MB, volume: 'E:', path: (i) => `E:\\clowder-ai\\user-state\\logs\\api-${String(i).padStart(3, '0')}.log` },
];

const VOLUMES = {
  'C:': { totalBytes: 512 * GB, freeBytes: 96 * GB },
  'E:': { totalBytes: 1024 * GB, freeBytes: 410 * GB },
  'G:': { totalBytes: 2048 * GB, freeBytes: 620 * GB },
};

function rows() {
  const output = [];
  let serial = 0;
  for (const category of CATEGORIES) {
    for (let index = 0; index < category.count; index += 1) {
      serial += 1;
      const logical = Math.round(category.min + ((index * 0.6180339887) % 1) * (category.max - category.min));
      const allocated = Math.round(logical * (category.id === 'temp' ? 0.82 : 1.04));
      const thread = THREADS[index % THREADS.length];
      const row = {
        path: category.path(index),
        volume: category.volume,
        category: category.id,
        threadIds: index % 11 === 0 ? [] : [thread.id],
        logicalBytes: logical,
        allocatedBytes: allocated,
        modifiedAt: NOW - serial * 37 * 60 * 1000,
      };
      if (category.id === 'worktree' && index % 97 === 0 && output.length > 0) {
        row.duplicateOf = output[output.length - 1].path;
      }
      output.push(row);
    }
  }
  return output.sort((left, right) => right.logicalBytes - left.logicalBytes);
}

function aggregate(allRows) {
  const volumes = new Map();
  const categories = new Map();
  const seen = new Set();
  for (const row of allRows) {
    const volume = volumes.get(row.volume) || {
      volume: row.volume,
      fileCount: 0,
      uniqueFiles: 0,
      logicalBytes: 0,
      allocatedBytes: 0,
      unmeasuredFiles: 0,
    };
    volumes.set(row.volume, volume);
    volume.fileCount += 1;
    const category = categories.get(row.category) || {
      category: row.category,
      fileCount: 0,
      uniqueFiles: 0,
      logicalBytes: 0,
      allocatedBytes: 0,
      unmeasuredFiles: 0,
    };
    categories.set(row.category, category);
    category.fileCount += 1;
    const identity = row.duplicateOf || row.path;
    if (seen.has(identity)) continue;
    seen.add(identity);
    volume.uniqueFiles += 1;
    volume.logicalBytes += row.logicalBytes;
    volume.allocatedBytes += row.allocatedBytes;
    category.uniqueFiles += 1;
    category.logicalBytes += row.logicalBytes;
    category.allocatedBytes += row.allocatedBytes;
  }
  return {
    volumes: [...volumes.values()].map((volume) => ({
      ...volume,
      ...(VOLUMES[volume.volume] || {}),
    })),
    categories: [...categories.values()],
  };
}

export function makeFixture(state = 'ready') {
  const allRows = rows();
  const { volumes, categories } = aggregate(allRows);
  const report = {
    state: 'ready',
    scannedAt: new Date(NOW - 8 * 60 * 1000).toISOString(),
    volumes,
    categories,
    threads: THREADS,
    files: allRows.slice(0, 100),
    omissions: [
      { path: 'C:\\Users\\Administrator\\.claude\\projects\\--C-Users-Administrator-AppData-Local-Clowder-AI-project--', reason: 'unreadable', count: 1 },
      { path: 'G:\\AIwork\\clowder-ai\\worktrees\\host-pr-2031\\node_modules', reason: 'link-or-mount', count: 1 },
      { path: 'G:\\AIwork\\clowder-ai\\worktrees\\runtime-memory-20261125', reason: 'worktree-unavailable', count: 1 },
      { path: 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\dsh-workspace-changes-8f2c', reason: 'unreadable', count: 1 },
    ],
    total: allRows.length,
    omissionCount: 4,
    roots: [
      { path: 'E:\\clowder-ai\\user-state\\.cat-cafe', category: 'database' },
      { path: 'C:\\Users\\Administrator\\.cat-cafe\\transcripts\\threads', category: 'transcript', optional: true },
      { path: 'C:\\Users\\Administrator\\.claude\\projects', category: 'native-session', optional: true },
      { path: 'G:\\AIwork\\clowder-ai\\worktrees\\host-pr-2065-storage', category: 'worktree' },
      { path: 'C:\\Users\\Administrator\\AppData\\Local\\Temp', category: 'temp' },
    ],
    rootCount: 5,
    nextOffset: allRows.length > 100 ? 100 : null,
  };
  if (state === 'idle') return { report: { state: 'idle' }, rows: allRows };
  if (state === 'unavailable') {
    return { report: { state: 'error', error: 'host-capability-unavailable' }, rows: allRows };
  }
  if (state === 'error') return { report: { state: 'error', error: 'scan-failed' }, rows: allRows };
  return { report, rows: allRows };
}

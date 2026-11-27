import { isAbsolute, resolve } from 'node:path';
import { summarize, type StorageFile, type StorageResult } from './scan.js';

const unassigned = '__unknown__';
const worktreeKey = (path: string) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));

function append<K, V>(index: Map<K, V[]>, key: K, row: V) {
  const rows = index.get(key);
  if (rows) rows.push(row);
  else index.set(key, [row]);
}

export function indexStorage(result: StorageResult) {
  const { files, omissions, ...summary } = result;
  const byCategory = new Map<string, StorageFile[]>();
  const byVolume = new Map<string, StorageFile[]>();
  const byThread = new Map<string, StorageFile[]>();
  const byWorktree = new Map<string, StorageFile[]>();
  for (const row of files) {
    append(byCategory, row.category, row);
    append(byVolume, row.volume, row);
    if (row.threadIds.length === 0) append(byThread, unassigned, row);
    else for (const id of row.threadIds) append(byThread, id, row);
    if (row.worktreePath) append(byWorktree, row.worktreePath, row);
  }

  const worktrees = [...byWorktree].flatMap(([path, rows]) => {
    const usage = summarize(rows)[0];
    if (!usage) return [];
    const threadIds = new Set<string>();
    for (const row of rows) for (const id of row.threadIds) threadIds.add(id);
    return [{ path, ...usage, threadIds: [...threadIds].sort() }];
  });
  worktrees.sort(
    (a, b) =>
      (b.allocatedBytes ?? -1) - (a.allocatedBytes ?? -1) ||
      b.logicalBytes - a.logicalBytes ||
      a.path.localeCompare(b.path),
  );

  return {
    summary: { ...summary, omissions: omissions.slice(0, 100), omissionCount: omissions.length, worktreeCount: worktrees.length },
    files, worktrees, byVolume, byCategory, byThread, byWorktree,
    worktreesByPath: new Map(worktrees.map((row) => [worktreeKey(row.path), row])),
  };
}

export function pageStorage(index: ReturnType<typeof indexStorage>, raw: Record<string, unknown>) {
  const str = (key: string) => (typeof raw[key] === 'string' ? raw[key].trim() : '');
  const offset = Number(typeof raw.offset === 'number' ? raw.offset : str('offset') || '0');
  const limit = Number(typeof raw.limit === 'number' ? raw.limit : str('limit') || '50');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    return null;

  const volume = str('volume').toUpperCase();
  const threadId = str('threadId');
  const term = str('query').toLowerCase();
  const view = str('view') === 'worktrees' ? 'worktrees' : 'files';
  const root = str('worktreePath');
  const worktree = isAbsolute(root) ? index.worktreesByPath.get(worktreeKey(root)) : undefined;
  const summary = raw.summary === false || raw.summary === 'false'
    ? { scannedAt: index.summary.scannedAt }
    : index.summary;

  if (view === 'worktrees') {
    const matches = index.worktrees.filter((row) =>
      (!volume || row.volume === volume) &&
      (!threadId || (threadId === unassigned ? !row.threadIds.length : row.threadIds.includes(threadId))) &&
      (!term || row.path.toLowerCase().includes(term)),
    );
    return {
      state: 'ready', ...summary, view, worktrees: matches.slice(offset, offset + limit), total: matches.length,
      ...(offset + limit < matches.length ? { nextOffset: offset + limit } : {}),
    };
  }

  const category = root && str('category') === 'worktree' ? '' : str('category');
  const candidates = [
    volume ? index.byVolume.get(volume) ?? [] : null,
    category ? index.byCategory.get(category) ?? [] : null,
    threadId ? index.byThread.get(threadId) ?? [] : null,
    root ? (worktree ? index.byWorktree.get(worktree.path) ?? [] : []) : null,
  ].filter((rows): rows is StorageFile[] => rows !== null);
  const source = candidates.reduce((shortest, rows) => rows.length < shortest.length ? rows : shortest, index.files);
  let total = source.length;
  let files = source.slice(offset, offset + limit);
  if (term || candidates.length > 1) {
    total = 0;
    files = [];
    for (const row of source) {
      if ((volume && row.volume !== volume) ||
          (category && row.category !== category) ||
          (threadId && (threadId === unassigned ? row.threadIds.length > 0 : !row.threadIds.includes(threadId))) ||
          (root && row.worktreePath !== worktree?.path) ||
          (term && !row.path.toLowerCase().includes(term))) continue;
      if (total >= offset && files.length < limit) files.push(row);
      total += 1;
    }
  }
  return {
    state: 'ready', ...summary, view, files, total,
    ...(worktree ? { worktree } : {}),
    ...(offset + limit < total ? { nextOffset: offset + limit } : {}),
  };
}

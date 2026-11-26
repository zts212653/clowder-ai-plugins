import { lstat, opendir, realpath, statfs } from 'node:fs/promises';
import { basename, isAbsolute, join, parse, resolve, sep } from 'node:path';

interface Source {
  path: string;
  category: string;
  threadId?: string;
  optional?: boolean;
}

export interface Sources {
  threads: { id: string; title: string | null }[];
  roots: Source[];
  files: Source[];
  nativeSessions: { id: string; threadId: string }[];
  omissions: { path: string; reason: string; count: number }[];
}

interface StorageFile {
  path: string;
  volume: string;
  category: string;
  threadIds: string[];
  logicalBytes: number;
  allocatedBytes: number | null;
  modifiedAt: number;
  duplicateOf?: string;
}

interface Volume {
  volume: string;
  fileCount: number;
  uniqueFiles: number;
  logicalBytes: number;
  allocatedBytes: number | null;
  unmeasuredFiles: number;
}

const onWindows = process.platform === 'win32';
const pathKey = (path: string) => (onWindows ? resolve(path).toLowerCase() : resolve(path));
const volumeOf = (path: string) => (onWindows ? parse(path).root.toUpperCase() : parse(path).root);
const nativeRolloutId = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?=\.jsonl(?:\.(?:zst|zstd))?$)/i;

export async function scanStorage(sources: Sources, signal: AbortSignal) {
  const results = new Map<string, StorageFile>();
  const directories = new Set<string>();
  const identities = new Map<string, StorageFile>();
  const rootsByPath = indexSources(sources.roots);
  const filesByPath = indexSources(sources.files);
  const native = new Map<string, Set<string>>();
  const omissions = new Map(sources.omissions.map((row) => [row.reason + '\n' + row.path, { ...row }]));

  for (const { id, threadId } of sources.nativeSessions) {
    const owners = native.get(id) ?? new Set<string>();
    owners.add(threadId);
    native.set(id, owners);
  }

  function omit(path: string, reason: string) {
    const key = reason + '\n' + path;
    const current = omissions.get(key);
    if (current) current.count += 1;
    else omissions.set(key, { path, reason, count: 1 });
  }

  function ownersFor(path: string, category: string, inherited: readonly string[]) {
    const owners = new Set([...inherited, ...(filesByPath.get(pathKey(path))?.owners ?? [])]);
    if (category === 'native-session' || category === 'attachment') {
      const candidates = path.split(sep);
      const filename = basename(path);
      candidates.push(filename.replace(/\.(?:jsonl(?:\.(?:zst|zstd))?|json)$/i, ''));
      const matches = filename.match(nativeRolloutId);
      if (matches) candidates.push(matches[0]);
      // Kimi stores sessions as `session_<uuid>` directories while the chain may
      // record only `<uuid>` (or the reverse). Match both spellings.
      for (const candidate of candidates.slice()) {
        if (candidate.startsWith('session_')) candidates.push(candidate.slice(8));
        else if (candidate.length > 0) candidates.push('session_' + candidate);
      }
      for (const candidate of candidates) {
        for (const id of native.get(candidate) ?? []) owners.add(id);
      }
    }
    return [...owners].sort();
  }

  async function walk(
    path: string,
    category: string,
    inherited: readonly string[],
    device?: bigint,
    directFile = false,
    optional = false,
  ): Promise<void> {
    signal.throwIfAborted();
    const key = pathKey(path);
    const stats = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (!optional || error.code !== 'ENOENT') omit(path, error.code === 'ENOENT' ? 'missing' : 'unreadable');
      return undefined;
    });
    if (!stats) return;
    if (stats.isSymbolicLink() || (device !== undefined && stats.dev !== device)) {
      omit(path, 'link-or-mount');
      return;
    }
    if (device === undefined) {
      const canonical = await realpath(path).catch(() => undefined);
      if (!canonical || pathKey(canonical) !== key) {
        omit(path, canonical ? 'link-or-mount' : 'unreadable');
        return;
      }
    }

    const specific = rootsByPath.get(key);
    const owners = specific ? [...new Set([...inherited, ...specific.owners])] : inherited;
    const location = specific?.source.category ?? category;
    if (stats.isDirectory() && !directFile) {
      if (directories.has(key)) return;
      directories.add(key);
      const entries = await opendir(path).catch(() => undefined);
      if (!entries) {
        omit(path, 'unreadable');
        return;
      }
      try {
        for await (const entry of entries) {
          const child = join(path, entry.name);
          if (location === 'worktree' && entry.name === '.git') continue;
          if (entry.isSymbolicLink()) omit(child, 'link-or-mount');
          else await walk(child, location, owners, stats.dev);
        }
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof Error) || !('code' in error)) throw error;
        omit(path, 'unreadable');
      }
      return;
    }
    if (!stats.isFile()) {
      omit(path, 'not-regular-file');
      return;
    }
    const categoryForFile = filesByPath.get(key)?.source.category ?? location;
    const threadIds = ownersFor(path, categoryForFile, owners);
    const previous = results.get(key);
    if (previous) {
      previous.threadIds = [...new Set([...previous.threadIds, ...threadIds])].sort();
      return;
    }

    const volume = volumeOf(path);
    const logicalBytes = safeBytes(stats.size);
    if (logicalBytes === null) {
      omit(path, 'size-out-of-range');
      return;
    }
    const allocatedBytes = typeof stats.blocks === 'bigint' ? safeBytes(stats.blocks * 512n) : null;
    const row: StorageFile = {
      path, volume, category: categoryForFile, threadIds, logicalBytes, allocatedBytes, modifiedAt: Number(stats.mtimeMs),
    };
    if (stats.nlink > 1n && stats.ino !== 0n && stats.dev !== 0n) {
      const identity = String(stats.dev) + ':' + String(stats.ino);
      const first = identities.get(identity);
      if (first) row.duplicateOf = first.path;
      else identities.set(identity, row);
    }
    results.set(key, row);
  }

  const roots = [...rootsByPath.values()].sort((a, b) => a.source.path.length - b.source.path.length);
  for (const { source } of roots) {
    if (directories.has(pathKey(source.path))) continue;
    await walk(source.path, source.category, [], undefined, false, source.optional);
  }
  for (const { source } of filesByPath.values()) {
    if (!results.has(pathKey(source.path))) await walk(source.path, source.category, [], undefined, true, source.optional);
  }

  const files = [...results.values()].sort(
    (a, b) =>
      (b.allocatedBytes ?? -1) - (a.allocatedBytes ?? -1) ||
      b.logicalBytes - a.logicalBytes ||
      a.path.localeCompare(b.path),
  );
  const volumes = await Promise.all(summarize(files).map(async (usage) => {
    const stats = await statfs(usage.volume, { bigint: true }).catch(() => undefined);
    return {
      ...usage,
      totalBytes: stats ? safeBytes(stats.blocks * stats.bsize) : null,
      freeBytes: stats ? safeBytes(stats.bavail * stats.bsize) : null,
    };
  }));
  const categories = new Map<string, StorageFile[]>();
  for (const file of files) {
    const group = categories.get(file.category) ?? [];
    group.push(file);
    categories.set(file.category, group);
  }
  return {
    scannedAt: new Date().toISOString(),
    files,
    volumes,
    categories: [...categories].map(([category, items]) => {
      const usage = summarize(items.filter((row) => !row.duplicateOf));
      return { category,
        fileCount: items.length,
        uniqueFiles: usage.reduce((total, row) => total + row.uniqueFiles, 0),
        logicalBytes: usage.reduce((total, row) => total + row.logicalBytes, 0),
        allocatedBytes: usage.every((row) => row.allocatedBytes !== null)
          ? usage.reduce((total, row) => total + (row.allocatedBytes ?? 0), 0)
          : null,
      };
    }),
    roots: roots.slice(0, 100).map(({ source }) => source),
    rootCount: roots.length,
    threads: sources.threads,
    omissions: [...omissions.values()],
  };
}

function indexSources(sources: Source[]) {
  const rows = new Map<string, { source: Source; owners: Set<string> }>();
  for (const source of sources) {
    if (!isAbsolute(source.path) || pathKey(source.path) === pathKey(parse(source.path).root)) continue;
    const key = pathKey(source.path);
    const entry = rows.get(key) ?? { source: { ...source, path: resolve(source.path) }, owners: new Set<string>() };
    if (source.threadId) entry.owners.add(source.threadId);
    rows.set(key, entry);
  }
  return rows;
}

function safeBytes(value: bigint) {
  return value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

export function summarize(files: readonly StorageFile[]) {
  const volumes = new Map<string, Volume>();
  const seen = new Set<string>();
  for (const file of files) {
    const volume = volumes.get(file.volume) ?? {
      volume: file.volume, fileCount: 0, uniqueFiles: 0, logicalBytes: 0, allocatedBytes: 0, unmeasuredFiles: 0,
    };
    volumes.set(volume.volume, volume);
    volume.fileCount += 1;
    const identity = pathKey(file.duplicateOf ?? file.path);
    if (seen.has(identity)) continue;
    seen.add(identity);
    volume.uniqueFiles += 1;
    volume.logicalBytes += file.logicalBytes;
    if (file.allocatedBytes === null) {
      volume.unmeasuredFiles += 1;
      volume.allocatedBytes = null;
    } else if (volume.allocatedBytes !== null) {
      volume.allocatedBytes += file.allocatedBytes;
    }
  }
  return [...volumes.values()].sort((a, b) => b.logicalBytes - a.logicalBytes || a.volume.localeCompare(b.volume));
}

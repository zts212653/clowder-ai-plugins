import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { posix } from 'node:path';

export interface SourceLock {
  repository: string;
  tag: string;
  commit: string;
  tree: string;
  archiveUrl: string;
  archiveSha256: string;
  rootDirectory: string;
  files: Readonly<Record<string, string>>;
}

export interface ArchiveEntry {
  path: string;
  type: 'file' | 'directory' | 'symbolic-link' | 'hard-link' | 'other';
}

export interface ArchiveAdmissionOptions {
  allowExcludedEnterprise?: boolean;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizedArchivePath(path: string): string {
  if (path.includes('\0') || path.includes('\\')) {
    throw new Error(`unsafe archive path: ${JSON.stringify(path)}`);
  }
  const normalized = posix.normalize(path.replace(/\/$/, ''));
  if (path.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`entry escapes the expected archive root: ${path}`);
  }
  return normalized;
}

export function isEnterpriseEntry(path: string, expectedRoot: string): boolean {
  const normalized = normalizedArchivePath(path);
  return normalized === `${expectedRoot}/ee` || normalized.startsWith(`${expectedRoot}/ee/`);
}

export function assertArchiveEntries(
  entries: readonly ArchiveEntry[],
  expectedRoot: string,
  options: ArchiveAdmissionOptions = {},
): void {
  if (entries.length === 0) throw new Error('source archive is empty');
  for (const entry of entries) {
    const normalized = normalizedArchivePath(entry.path);
    if (normalized !== expectedRoot && !normalized.startsWith(`${expectedRoot}/`)) {
      throw new Error(`entry is outside the expected archive root: ${entry.path}`);
    }
    if (entry.type === 'symbolic-link' || entry.type === 'hard-link') {
      throw new Error(`archive link entries are forbidden: ${entry.path}`);
    }
    if (entry.type !== 'file' && entry.type !== 'directory') {
      throw new Error(`unsupported archive entry type ${entry.type}: ${entry.path}`);
    }
    if (isEnterpriseEntry(normalized, expectedRoot) && !options.allowExcludedEnterprise) {
      throw new Error(`enterprise source must be excluded before extraction: ${entry.path}`);
    }
  }
}

async function assertRegularTree(root: string, relative = ''): Promise<void> {
  const directory = relative ? `${root}/${relative}` : root;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (relative === '' && entry.name === 'node_modules') continue;
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (childRelative === 'ee' || childRelative.startsWith('ee/')) {
      throw new Error(`enterprise source is forbidden after extraction: ${childRelative}`);
    }
    const child = `${root}/${childRelative}`;
    const metadata = await lstat(child);
    if (metadata.isSymbolicLink()) throw new Error(`source symlink is forbidden: ${childRelative}`);
    if (metadata.isDirectory()) await assertRegularTree(root, childRelative);
    else if (!metadata.isFile()) throw new Error(`non-regular source entry: ${childRelative}`);
  }
}

export async function assertExtractedSource(sourceRoot: string, lock: SourceLock): Promise<void> {
  await assertRegularTree(sourceRoot);
  for (const [relativePath, expectedDigest] of Object.entries(lock.files)) {
    const metadata = await lstat(`${sourceRoot}/${relativePath}`);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`locked source file is not regular: ${relativePath}`);
    }
    const actualDigest = sha256Hex(await readFile(`${sourceRoot}/${relativePath}`));
    if (actualDigest !== expectedDigest) {
      throw new Error(
        `locked source digest mismatch for ${relativePath}: expected ${expectedDigest}, got ${actualDigest}`,
      );
    }
  }
}

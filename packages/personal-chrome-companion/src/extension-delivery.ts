import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** No symlinks: copying a package must not expand its read/write authority. */
export async function extensionFiles(directory: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const visit = async (relative: string): Promise<void> => {
    const path = join(directory, relative);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error('extension symlinks are not supported');
    if (metadata.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await visit(join(relative, child));
    } else if (metadata.isFile()) {
      files.set(relative, await readFile(path));
    } else throw new Error('extension entry must be a regular file or directory');
  };
  await visit('');
  return files;
}

export function extensionDigest(files: ReadonlyMap<string, Buffer>): string {
  const hash = createHash('sha256');
  for (const [name, bytes] of files) hash.update(name).update('\0').update(bytes).update('\0');
  return hash.digest('hex');
}

/** Caller holds the install lease. The previous complete directory is recoverable until activation. */
export async function replaceExtension<T>(dataDirectory: string, files: ReadonlyMap<string, Buffer>,
  activate: () => Promise<T>): Promise<T> {
  const destination = join(dataDirectory, 'extension');
  const staging = join(dataDirectory, `.extension-${randomUUID()}`);
  const backup = join(dataDirectory, `.extension-previous-${randomUUID()}`);
  let backedUp = false;
  let activated = false;
  await mkdir(staging, { mode: 0o700 });
  try {
    for (const [name, bytes] of files) {
      await mkdir(dirname(join(staging, name)), { recursive: true, mode: 0o700 });
      await writeFile(join(staging, name), bytes, { mode: 0o600, flag: 'wx' });
    }
    try {
      await rename(destination, backup);
      backedUp = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await rename(staging, destination);
      const result = await activate();
      activated = true;
      return result;
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      if (backedUp) await rename(backup, destination);
      throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (activated && backedUp) await rm(backup, { recursive: true, force: true });
  }
}

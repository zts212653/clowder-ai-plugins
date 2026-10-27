import { constants } from 'node:fs';
import { open, lstat, mkdir, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { MusicError } from './types.js';

export async function readPrivateJson(path: string, limit = 32 * 1024, publication = false): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.nlink !== 1 && !(publication && stat.nlink === 2)) || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || stat.size > limit)
      throw new MusicError('private_file_invalid');
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) throw new MusicError('private_file_invalid');
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700, recursive: true });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new MusicError('private_directory_invalid');
}
/** New immutable records only. An existing record never grants permission to overwrite it. */
export async function writeNew(path: string, bytes: Uint8Array | string): Promise<void> {
  const temporary = `${path}.pending-${randomUUID()}`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  try { await link(temporary, path); }
  finally { await unlink(temporary); }
  const directory = await open(dirname(path), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function readOptional(path: string, limit?: number): Promise<unknown | undefined> {
  try { return await readPrivateJson(path, limit, true); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

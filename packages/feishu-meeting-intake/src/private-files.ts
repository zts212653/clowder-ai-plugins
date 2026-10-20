import { constants } from 'node:fs';
import { mkdir, lstat, open, link, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Meeting private directory is invalid');
}
export async function readPrivate(path: string, maximum = 64 * 1024): Promise<Buffer | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > maximum) throw new Error('Meeting private file is invalid');
    const bytes = Buffer.alloc(maximum + 1);
    let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    if (offset > maximum) throw new Error('Meeting private file exceeds its bound');
    return bytes.subarray(0, offset);
  } finally { await file.close(); }
}
export async function writePrivate(path: string, bytes: string | Buffer, assertCurrent: () => Promise<void>, exclusive = false): Promise<void> {
  await privateDirectory(dirname(path));
  const temporary = join(dirname(path), '.' + randomUUID() + '.tmp');
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await assertCurrent();
    if (exclusive) await link(temporary, path); else await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

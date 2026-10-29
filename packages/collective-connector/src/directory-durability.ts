import { open } from 'node:fs/promises';

/**
 * Make a directory-entry update durable where the host filesystem exposes POSIX-style directory fsync.
 * Windows rejects fsync on directory handles with EPERM, so callers retain their file fsync and rename
 * guarantees without attempting that unsupported operation. Errors on supported platforms remain fatal.
 */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

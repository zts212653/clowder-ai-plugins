import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

type ProfileWriteFileOps = Pick<typeof import('node:fs'), 'writeFileSync' | 'renameSync' | 'rmSync'>;
const DEFAULT_FILE_OPS = { writeFileSync, renameSync, rmSync };

export function atomicWriteUtf8(path: string, content: string, fileOps: ProfileWriteFileOps = DEFAULT_FILE_OPS): void {
  const tmpPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fileOps.writeFileSync(tmpPath, content, { encoding: 'utf8', flag: 'wx' });
    fileOps.renameSync(tmpPath, path);
  } catch (err) {
    try {
      fileOps.rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup only; preserving the existing primer is the invariant.
    }
    throw err;
  }
}

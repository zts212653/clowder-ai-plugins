import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_SECRET_BYTES = 2_048;

export interface ReadSecretFileOptions {
  readonly required: boolean;
}

function validateSecret(secret: string): void {
  if (
    secret.length < 8 ||
    Buffer.byteLength(secret, 'utf8') > MAX_SECRET_BYTES ||
    /[\r\n\u0000-\u001f\u007f]/u.test(secret)
  ) {
    throw new TypeError('Secret file must contain a single line of bounded content');
  }
}

export async function readSecretFile(
  path: string,
  options: ReadSecretFileOptions,
): Promise<string | undefined> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !options.required) {
      return undefined;
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('Secret path must be a regular file');
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error('Secret file must have owner-only permissions');
  }
  if (metadata.size > MAX_SECRET_BYTES + 1) {
    throw new Error('Secret file exceeds the size limit');
  }

  const raw = await readFile(path, 'utf8');
  const secret = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  validateSecret(secret);
  return secret;
}

export async function writeSecretFile(path: string, secret: string): Promise<void> {
  validateSecret(secret);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${secret}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { syncDirectory } from '../../directory-durability.js';
import { createSecret } from './persistence.js';

export async function readBootstrapSecret(path: string): Promise<string> {
  const secret = (await readFile(path, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('Private owner bootstrap credential is invalid');
  return secret;
}

/** Persist before creating Service state, so a crash never strands an unclaimed instance. */
export async function escrowBootstrapSecret(path: string): Promise<string> {
  try {
    return await readBootstrapSecret(path);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const secret = createSecret();
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(secret + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
  return secret;
}

export async function writeBootstrapLink(path: string, link: string): Promise<void> {
  const temporaryPath = path + '.' + randomUUID() + '.tmp';
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(link + '\n', 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/** Earlier source-only launches escrowed only the URL. Keep that credential on upgrade. */
export async function recoverBootstrapSecret(secretPath: string, linkPath: string): Promise<string> {
  try {
    return await readBootstrapSecret(secretPath);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const previous = new URL((await readFile(linkPath, 'utf8')).trim());
  const secret = new URLSearchParams(previous.hash.slice(1)).get('bootstrap');
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret))
    throw new Error('Restore the original private bootstrap credential');
  await writeFile(secretPath, secret + '\n', { flag: 'wx', mode: 0o600 });
  return secret;
}

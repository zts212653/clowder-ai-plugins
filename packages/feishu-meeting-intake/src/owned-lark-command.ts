import { spawn } from 'node:child_process';
import { createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { privateDirectory, readPrivate, writePrivate } from './private-files.js';
import { parseLarkCliReadOutput } from './lark-cli-read-command.js';


export type OwnedLarkCommand = (args: readonly string[], signal: AbortSignal, cwd?: string) => Promise<unknown>;
/** CLI1.0.85 Darwin file backend, internal/keychain/keychain_darwin.go.
 * A valid owned fallback master prevents global Keychain writes. Authenticate every
 * existing .enc before any child so platformGet cannot fall back on decryption failure.
 * No downgrade command, ambient profile or inherited credential environment is used. */
export async function prepareOwnedLarkHome(home: string, assertCurrent: () => Promise<void>): Promise<void> {
  if (!['darwin','linux'].includes(process.platform)) throw new Error('Owned Lark credential backend currently requires macOS/Linux');
  await privateDirectory(home);
  let directory = home;
  for (const segment of (process.platform === 'darwin' ? ['Library', 'Application Support', 'lark-cli'] : ['.local','share','lark-cli'])) { directory = join(directory, segment); await privateDirectory(directory); }
  const path = join(directory, process.platform === 'darwin' ? 'master.key.file' : 'master.key');
  let key = await readPrivate(path, 32);
  if (!key) {
    if ((await readdir(directory)).some(name => name.endsWith('.enc'))) throw new Error('Meeting credential recovery required');
    try { await writePrivate(path, randomBytes(32), assertCurrent, true); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    key = await readPrivate(path, 32);
  }
  if (!key || key.length !== 32) throw new Error('Meeting credential recovery required');
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.enc')) continue;
    const bytes = await readPrivate(join(directory, name));
    if (!bytes || bytes.length < 28) throw new Error('Meeting credential recovery required');
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      decipher.update(bytes.subarray(12, -16)); decipher.final();
    } catch { throw new Error('Meeting credential recovery required'); }
  }
  await assertCurrent();
}
export async function configureOwnedLarkHome(home: string, appId: string, appSecret: string, assertCurrent: () => Promise<void>): Promise<void> {
  if (!/^cli_[A-Za-z0-9]{1,120}$/.test(appId) || appSecret.length < 1 || appSecret.length > 1024 || /[\x00-\x1f]/.test(appSecret)) throw new Error('Configure the Feishu app ID and secret in Settings');
  await prepareOwnedLarkHome(home, assertCurrent);
  const path = join(home, '.lark-cli', 'config.json');
  const old = await readPrivate(path);
  if (old) {
    let config;
    try { config = JSON.parse(old.toString('utf8')); } catch { throw new Error('Meeting account configuration is corrupt: recovery required'); }
    if (config.currentApp !== appId || config.apps?.length !== 1 || config.apps[0].appId !== appId || config.apps[0].appSecret !== appSecret) throw new Error('Account configuration changed: restore the original app before reconciling authorization');
    return;
  }
  // The pinned CLI explicitly accepts a SecretInput plain string. It stays in
  // this private 0600 compartment; never argv, environment, MCP, UI or logs.
  await writePrivate(path, JSON.stringify({ currentApp: appId, apps: [{ appId, appSecret, brand: 'feishu', defaultAs: 'user', users: [] }] }), assertCurrent, true);
}
export function createOwnedLarkCommand(home: string, assertCurrent: () => Promise<void>): OwnedLarkCommand {
  return async (args, signal, cwd = home) => {
    await prepareOwnedLarkHome(home, assertCurrent); signal.throwIfAborted();
    const directory = fileURLToPath(new URL('../dist/', import.meta.url));
    const runner = JSON.parse(await readFile(join(directory, 'lark-cli-runtime.json'), 'utf8'));
    if (runner.version !== '1.0.85' || runner.platform !== process.platform || runner.arch !== process.arch || createHash('sha256').update(await readFile(join(directory, 'lark-cli'))).digest('hex') !== runner.binarySha256) throw new Error('Pinned meeting runner integrity is unavailable');
    await assertCurrent(); signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(join(directory, 'lark-cli'), [...args], {
        cwd, env: { HOME: home }, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = Buffer.alloc(0), size = 0, failure: unknown;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const killGroup = (signal: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } } };
      const fail = (reason: unknown) => { if (failure) return; failure = reason; killGroup('SIGTERM'); killTimer = setTimeout(() => killGroup('SIGKILL'), 100); };
      const abort = () => fail(signal.reason ?? new Error('Meeting command cancelled'));
      const timer = setTimeout(() => fail(new Error('Meeting command timed out: check account before retrying authorization')), 25_000);
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 2_000_000) fail(new Error('Meeting command output exceeded its bound')); else stdout = Buffer.concat([stdout, chunk]); });
      let diagnosticSize = 0;
      child.stderr.on('data', (chunk: Buffer) => { diagnosticSize += chunk.length; if (diagnosticSize > 32_768) fail(new Error('Meeting command diagnostics exceeded their bound')); });
      child.once('error', () => { failure = new Error('Meeting provider process could not start'); });
      child.once('close', async code => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (killTimer) { clearTimeout(killTimer); killGroup('SIGKILL'); }
        try {
          if (failure) throw failure;
          if (code !== 0) throw new Error('Feishu command failed; verify account and source permissions');
          await assertCurrent(); signal.throwIfAborted();
          resolve(parseLarkCliReadOutput(stdout.toString('utf8')));
        } catch (error) { reject(error); }
      });
      if (signal.aborted) abort();
    });
  };
}

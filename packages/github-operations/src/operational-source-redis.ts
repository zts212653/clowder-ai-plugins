import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { assertLegacyRead, assertLegacyScan, operatorConfigSchema, type OperatorConfig } from './operational-source-policy.js';
import type { LegacyReadPort } from './operational-source.js';
const execute = promisify(execFile);

/** No ioredis connection, mutating read-store helper, shell, or caller-supplied
 * Redis expression is used. Authorization for a production read remains an
 * external owner decision; matching a plan digest is only a configuration fence. */
export async function openLegacyReadPort(config: OperatorConfig, signal: AbortSignal) {
  operatorConfigSchema.parse(config);
  const path = await realpath(config.redisCli),
    info = await stat(path);
  if (!info.isFile() || (info.mode & 0o022) !== 0)
    throw new Error('Trusted Redis binary must not be group/world writable');
  const digest = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
  if (digest !== config.redisCliSha256) throw new Error('Redis executable changed since plan approval');
  const password = config.passwordEnv ? process.env[config.passwordEnv] : undefined;
  if (config.passwordEnv && !password) throw new Error('Explicit existing credential environment is missing');
  const connection =
    config.connection.kind === 'unix'
      ? ['-s', config.connection.socket]
      : [
          '-h',
          config.connection.host,
          '-p',
          String(config.connection.port),
          ...(config.connection.tls ? ['--tls'] : []),
        ];
  const args = ['--json', '--no-auth-warning', ...connection, '-n', String(config.database), '--user', config.username];
  const tally: Record<string, number> = Object.create(null);
  let commands = 0;
  const reader: LegacyReadPort = {
    async read(command, ...values) {
      signal.throwIfAborted();
      if (command === 'SCAN') assertLegacyScan(config.scope, values);
      else assertLegacyRead(config.scope, command, values);
      if (++commands > 50000) throw new Error('GitHub source read exceeds command bound');
      tally[command] = (tally[command] ?? 0) + 1;
      let stdout: string;
      try {
        ({ stdout } = await execute(path, [...args, command, ...values], {
          signal,
          timeout: 5000,
          maxBuffer: 2 * 1024 * 1024,
          env: { PATH: '/usr/bin:/bin', LANG: 'C', ...(password ? { REDISCLI_AUTH: password } : {}) },
        }));
      } catch {
        signal.throwIfAborted();
        throw new Error('Bounded legacy Redis read failed; no raw server output disclosed');
      }
      try {
        return JSON.parse(stdout) as unknown;
      } catch {
        throw new Error('Legacy Redis refused read or returned invalid JSON');
      }
    },
  };
  if ((await reader.read('PING')) !== 'PONG' || (await reader.read('ACL', 'WHOAMI')) !== config.username)
    throw new Error('Legacy Redis identity does not match approved plan');
  return {
    reader,
    proof: () => ({
      commands,
      tally: { ...tally },
      binarySha256: digest,
      identity: config.username,
      writeCommands: 0,
      authorityBodiesRead: false,
      messageBodiesRead: false,
      serverAclProvenReadOnly: false,
    }),
  };
}

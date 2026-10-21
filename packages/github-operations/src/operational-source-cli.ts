import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalBytes, freezeGitHubSource, sourceDigest } from './migration-source.js';
import { operatorConfigSchema, type OperatorConfig } from './operational-source-policy.js';
import { openLegacyReadPort } from './operational-source-redis.js';
import { collectLegacyGitHubSource } from './operational-source.js';

export async function readOperatorConfig(path: string): Promise<OperatorConfig> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() || info.size > 32000)
      throw new Error('Operator plan must be private, owned, regular and bounded');
    const buffer = Buffer.alloc(32001),
      { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 32000) throw new Error('Operator plan grew beyond bound');
    const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    return operatorConfigSchema.parse(value);
  } finally {
    await file.close();
  }
}
export function legacyReadPlan(config: OperatorConfig) {
  return {
    v: 1,
    config,
    planDigest: sourceDigest(config),
    productionReadAuthorized: false,
    commands: [
      'PING',
      'ACL WHOAMI',
      'ZCARD',
      'ZRANGE',
      'HMGET',
      'HGET',
      'HEXISTS',
      'GET',
      'SCARD',
      'SMEMBERS',
      'SCAN',
      'SSCAN',
    ],
    connectionCommands: ['AUTH (existing environment credential only, if configured)', 'SELECT (explicit database)'],
    restrictions:
      'Fixed GitHub families/fields only; no body/authority reads, writes, snapshots or whole-store dump. SCAN MATCH is scoped but Redis may internally traverse its key dictionary.',
    oldWriterProof:
      'Operator-provided external evidence reference, not inferred from stable reads or permission to stop a writer.',
  };
}
export async function exportLegacySource(
  config: OperatorConfig,
  expectedDigest: string,
  output: string,
  signal: AbortSignal,
) {
  if (expectedDigest !== sourceDigest(config)) throw new Error('Operator plan changed; no connection attempted');
  signal.throwIfAborted();
  // Reserve the new private output before any connection. Failure removes no
  // pre-existing file and leaves a visibly incomplete, private file for inspection.
  const file = await open(output, 'wx', 0o600);
  try {
    const port = await openLegacyReadPort(config, signal);
    const frozen = await freezeGitHubSource(
      { read: (s) => collectLegacyGitHubSource(port.reader, config.scope, s) },
      signal,
    );
    signal.throwIfAborted();
    await file.writeFile(canonicalBytes({ ...frozen, readOnlyProof: port.proof(), planDigest: expectedDigest }));
    await file.sync();
    return {
      digest: frozen.digest,
      counts: frozen.counts,
      planDigest: expectedDigest,
      readOnlyProof: port.proof(),
      rawContentPrinted: false,
    };
  } finally {
    await file.close();
  }
}
if (process.argv[1] && (await realpath(process.argv[1]).catch(() => '')) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        config: { type: 'string' },
        plan: { type: 'boolean' },
        'execute-plan': { type: 'string' },
        output: { type: 'string' },
      },
      allowPositionals: false,
    });
    if (!values.config) throw new Error('Explicit private operator config is required');
    const config = await readOperatorConfig(values.config);
    if (values.plan && !values['execute-plan'] && !values.output)
      process.stdout.write(JSON.stringify(legacyReadPlan(config)) + '\n');
    else if (!values.plan && values['execute-plan'] && values.output)
      process.stdout.write(
        JSON.stringify(
          await exportLegacySource(config, values['execute-plan'], values.output, AbortSignal.timeout(300000)),
        ) + '\n',
      );
    else throw new Error('Choose offline --plan or an approved --execute-plan with new --output');
  } catch {
    process.stderr.write(
      'GitHub source operation refused or incomplete; inspect the private plan and source preconditions.\n',
    );
    process.exitCode = 1;
  }
}

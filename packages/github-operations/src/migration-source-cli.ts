import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertSourceEnvelope, canonicalBytes, freezeGitHubSource } from './migration-source.js';

/** Operator-only file producer; not a module action or a path accepted over HTTP.
 * Input must already be the owner-authorized GitHub-only export. It cannot read
 * legacy Redis/Host stores, upgrade source trust, or make incomplete input complete. */
export async function freezeSourceFile(input: string, output: string, signal: AbortSignal) {
  const read = async () => {
    signal.throwIfAborted();
    const file = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await file.stat()).isFile()) throw new Error('Source must be a regular file');
      const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead === buffer.length) throw new Error('Source exceeds 2 MiB');
      let value: unknown;
      try { value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')); }
      catch { throw new Error('Source is not valid GitHub-only JSON'); }
      assertSourceEnvelope(value); return value;
    } finally { await file.close(); }
  };
  const frozen = await freezeGitHubSource({ read }, signal);
  signal.throwIfAborted();
  const file = await open(output, 'wx', 0o600);
  try { await file.writeFile(canonicalBytes(frozen)); await file.sync(); }
  finally { await file.close(); }
  return { digest: frozen.digest, counts: frozen.counts, rawContentPrinted: false };
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { input: { type: 'string' }, output: { type: 'string' } }, allowPositionals: false });
  if (!values.input || !values.output) throw new Error('Explicit GitHub-only source input and new private output paths required');
  const summary = await freezeSourceFile(values.input, values.output, AbortSignal.timeout(30_000));
  process.stdout.write(JSON.stringify(summary) + '\n');
}

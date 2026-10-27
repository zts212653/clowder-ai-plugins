import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { chmod, open, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { z } from 'zod';
import { privateDirectory, readPrivate, writePrivate } from './private-files.js';

const MAX_RUNNER_BYTES = 64 * 1024 * 1024;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const checksum = z.string().regex(/^[a-f0-9]{64}$/);

function runnerSchema(
  platform: 'darwin' | 'linux',
  arch: 'arm64' | 'x64',
  asset: string,
  archiveSha256: string,
) {
  return z
    .object({
      platform: z.literal(platform),
      arch: z.literal(arch),
      asset: z.literal(asset),
      source: z.literal(`https://github.com/larksuite/cli/releases/download/v1.0.85/${asset}`),
      archiveSha256: z.literal(archiveSha256),
      binarySha256: checksum,
      binaryBytes: z.number().int().positive().max(MAX_RUNNER_BYTES),
    })
    .strict();
}

const manifestSchema = z
  .object({
    version: z.literal('1.0.85'),
    runners: z
      .object({
        'darwin-arm64': runnerSchema(
          'darwin',
          'arm64',
          'lark-cli-1.0.85-darwin-arm64.tar.gz',
          '1c07f259de7201f3f7c88311bd63ec67cd2e9c5a3b1f7e497bf3c92f1a12b0f9',
        ),
        'linux-x64': runnerSchema(
          'linux',
          'x64',
          'lark-cli-1.0.85-linux-amd64.tar.gz',
          '78767460e6c8bb9811d9f28e8df7cd2721b14fdceb5b65ba42bf43e448c4bb78',
        ),
      })
      .strict(),
  })
  .strict();

type RunnerEntry = z.infer<typeof manifestSchema>['runners']['darwin-arm64' | 'linux-x64'];

export interface OwnedLarkRunner {
  readonly executable: string;
  readonly platform: 'darwin' | 'linux';
  readonly arch: 'arm64' | 'x64';
  readonly archiveSha256: string;
  readonly binarySha256: string;
}

async function readPackagedArchive(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_RUNNER_BYTES)
      throw new Error('Pinned meeting runner archive is invalid');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== bytes.length) throw new Error('Pinned meeting runner archive is incomplete');
    return bytes;
  } finally {
    await file.close();
  }
}

function tarSize(field: Buffer): number {
  const value = field.toString('ascii').replace(/\0.*$/u, '').trim();
  if (!/^[0-7]+$/u.test(value)) throw new Error('Pinned meeting runner archive has an invalid member');
  const size = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_RUNNER_BYTES)
    throw new Error('Pinned meeting runner archive has an invalid member');
  return size;
}

function extractRunner(archive: Buffer): Buffer {
  const tar = gunzipSync(archive, { maxOutputLength: MAX_RUNNER_BYTES });
  let found: Buffer | undefined;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/u, '');
    const path = prefix ? `${prefix}/${name}` : name;
    const size = tarSize(header.subarray(124, 136));
    const type = header[156];
    const start = offset + 512;
    const end = start + size;
    if (end > tar.length) throw new Error('Pinned meeting runner archive is truncated');
    if (path === 'lark-cli') {
      if ((type !== 0 && type !== 48) || found)
        throw new Error('Pinned meeting runner archive has an invalid executable member');
      found = Buffer.from(tar.subarray(start, end));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (!found || found.length === 0) throw new Error('Pinned meeting runner archive is missing its executable');
  return found;
}

function selectRunner(manifest: z.infer<typeof manifestSchema>): RunnerEntry {
  const key = `${process.platform}-${process.arch}`;
  if (key === 'darwin-arm64') return manifest.runners['darwin-arm64'];
  if (key === 'linux-x64') return manifest.runners['linux-x64'];
  throw new Error(`Pinned meeting runner is unavailable for ${key}`);
}

export async function materializeOwnedLarkRunner(
  home: string,
  assertCurrent: () => Promise<void>,
): Promise<OwnedLarkRunner> {
  const distribution = fileURLToPath(new URL('../dist/', import.meta.url));
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(distribution, 'lark-cli-runners.json'), 'utf8')),
  );
  const selected = selectRunner(manifest);
  await privateDirectory(home);
  let directory = home;
  for (const segment of ['.clowder-runner', `${selected.platform}-${selected.arch}`]) {
    directory = join(directory, segment);
    await privateDirectory(directory);
  }
  const executable = join(directory, 'lark-cli');
  const existing = await readPrivate(executable, MAX_RUNNER_BYTES);
  if (!existing || existing.length !== selected.binaryBytes || digest(existing) !== selected.binarySha256) {
    const archive = await readPackagedArchive(join(distribution, 'lark-cli-runners', selected.asset));
    if (digest(archive) !== selected.archiveSha256)
      throw new Error('Pinned meeting runner archive integrity is unavailable');
    const binary = extractRunner(archive);
    if (binary.length !== selected.binaryBytes || digest(binary) !== selected.binarySha256)
      throw new Error('Pinned meeting runner integrity is unavailable');
    await writePrivate(executable, binary, assertCurrent);
  }
  await assertCurrent();
  await chmod(executable, 0o700);
  await assertCurrent();
  const verified = await readPrivate(executable, MAX_RUNNER_BYTES);
  if (!verified || verified.length !== selected.binaryBytes || digest(verified) !== selected.binarySha256)
    throw new Error('Pinned meeting runner integrity is unavailable');
  return {
    executable,
    platform: selected.platform,
    arch: selected.arch,
    archiveSha256: selected.archiveSha256,
    binarySha256: selected.binarySha256,
  };
}
